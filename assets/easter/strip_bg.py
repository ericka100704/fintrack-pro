from pathlib import Path
from PIL import Image

BASE = Path(r"c:\Users\ckayd\xammp\htdocs\deploy-main\deploy-main\assets\easter")


def is_bg(r, g, b, a):
    if a < 20:
        return True
    mx, mn = max(r, g, b), min(r, g, b)
    sat = mx - mn
    avg = (r + g + b) / 3
    if avg > 235 and sat < 45:
        return True
    if avg > 220 and sat < 18:
        return True
    if sat < 25 and 150 <= avg <= 245:
        return True
    return False


def flood(path: Path, size: int | None = None) -> None:
    im = Image.open(path).convert("RGBA")
    bak = path.with_suffix(".bak.png")
    if not bak.exists():
        im.save(bak)
    w, h = im.size
    pix = im.load()
    vis = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        stack += [(0, x), (h - 1, x)]
    for y in range(h):
        stack += [(y, 0), (y, w - 1)]
    while stack:
        y, x = stack.pop()
        if not (0 <= y < h and 0 <= x < w) or vis[y][x]:
            continue
        r, g, b, a = pix[x, y]
        if not is_bg(r, g, b, a):
            continue
        vis[y][x] = True
        pix[x, y] = (0, 0, 0, 0)
        stack += [(y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)]
    for y in range(h):
        for x in range(w):
            r, g, b, a = pix[x, y]
            if a and is_bg(r, g, b, a):
                pix[x, y] = (0, 0, 0, 0)
    if size:
        bbox = im.split()[-1].getbbox()
        if bbox:
            pad = 8
            l, t, r, b = bbox
            im = im.crop((max(0, l - pad), max(0, t - pad), min(w, r + pad), min(h, b + pad)))
        im.thumbnail((size, size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
        canvas.save(path, optimize=True)
        print(path.name, canvas.size, canvas.getpixel((0, 0)))
    else:
        im.save(path, optimize=True)
        print(path.name, im.size, im.getpixel((0, 0)))


flood(BASE / "bunny.png", 512)
flood(BASE / "egg-mini.png", 256)
flood(BASE / "flower-mini.png", 256)
hero = Image.open(BASE / "hero-scene.png").convert("RGBA")
hero.thumbnail((1280, 720), Image.Resampling.LANCZOS)
hero.save(BASE / "hero-scene.png", optimize=True)
print("hero", hero.size)
