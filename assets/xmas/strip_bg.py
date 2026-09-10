"""Careful strip: remove only gray/white/checker; protect green/red/gold art."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

BASE = Path(__file__).resolve().parent


def is_art(r: int, g: int, b: int) -> bool:
    """True if pixel looks like festive subject (not bg)."""
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    avg = (r + g + b) / 3
    # green needles / holly
    if g > r + 8 and g > b + 5 and g > 55:
        return True
    # red berries / gift / ribbon
    if r > g + 25 and r > b + 15 and r > 80:
        return True
    # gold / yellow bauble & ribbon
    if r > 120 and g > 90 and r > b + 25 and g > b + 15:
        return True
    # brown stem / wood
    if r > 70 and g > 40 and b < 90 and r >= g >= b and sat > 20 and avg < 180:
        return True
    # dark pine / shadow on subject
    if avg < 90 and sat > 15:
        return True
    return False


def is_bg(r: int, g: int, b: int, a: int = 255) -> bool:
    if a < 20:
        return True
    if is_art(r, g, b):
        return False
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    avg = (r + g + b) / 3
    # classic checker / white / light gray
    if sat < 32 and avg >= 155:
        return True
    if avg > 235 and sat < 50:
        return True
    return False


def process(name: str, size: int) -> None:
    bak = BASE / name.replace(".png", ".bak.png")
    src = bak if bak.exists() else BASE / name
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    pix = im.load()

    visited = [[False] * w for _ in range(h)]
    stack: list[tuple[int, int]] = []
    for x in range(w):
        stack.append((0, x))
        stack.append((h - 1, x))
    for y in range(h):
        stack.append((y, 0))
        stack.append((y, w - 1))

    while stack:
        y, x = stack.pop()
        if not (0 <= y < h and 0 <= x < w) or visited[y][x]:
            continue
        r, g, b, a = pix[x, y]
        if not is_bg(r, g, b, a):
            continue
        visited[y][x] = True
        pix[x, y] = (0, 0, 0, 0)
        stack.extend(((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)))

    # Enclosed checker holes only (must be bg-colored AND mostly surrounded by bg/clear)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            r, g, b, a = pix[x, y]
            if a == 0 or not is_bg(r, g, b, a):
                continue
            nbrs = [pix[x + dx, y + dy] for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1))]
            if sum(1 for n in nbrs if n[3] == 0 or is_bg(*n)) >= 3:
                pix[x, y] = (0, 0, 0, 0)

    # Light fringe only (pale + next to transparent), never touch art colors
    for _ in range(2):
        kill: list[tuple[int, int]] = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = pix[x, y]
                if a == 0 or is_art(r, g, b):
                    continue
                near = any(
                    0 <= y + dy < h
                    and 0 <= x + dx < w
                    and pix[x + dx, y + dy][3] == 0
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1))
                )
                if not near:
                    continue
                sat = max(r, g, b) - min(r, g, b)
                avg = (r + g + b) / 3
                if avg > 185 and sat < 35:
                    kill.append((x, y))
                elif a < 100 and sat < 40 and avg > 150:
                    kill.append((x, y))
        for x, y in kill:
            pix[x, y] = (0, 0, 0, 0)

    alpha = im.split()[-1]
    bbox = alpha.getbbox()
    if bbox:
        pad = max(6, size // 40)
        l, t, r, b = bbox
        l, t = max(0, l - pad), max(0, t - pad)
        r, b = min(w, r + pad), min(h, b + pad)
        im = im.crop((l, t, r, b))

    im.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    canvas.save(BASE / name, optimize=True)

    data = list(canvas.getdata())
    trans = sum(1 for p in data if p[3] < 10) / (size * size)
    print(f"{name}: trans={trans*100:.1f}% corner={canvas.getpixel((0,0))}")


if __name__ == "__main__":
    for n, s in (("corner-pine.png", 512), ("holly-mini.png", 256), ("tree-mini.png", 256)):
        process(n, s)
