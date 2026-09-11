# FinWise — Handover Notes

Soft, dashboard-first personal finance hub (PHP ₱). Auth and data live in **localStorage** (`fintrack_users`, `fintrack_current_user`). Stack: Tailwind CDN, Chart.js, Lucide, canvas-confetti.

## Important behaviors

- **Forgot Password** is **client-side only**. Looking up an email and setting a new password updates `localStorage` — **no email is sent** and there is no backend mailer.
- **Seasonal accents** (subtle CSS, layered on the active theme; Settings → Themes can preview or turn off):
  - Christmas: Dec 15 – Jan 5
  - Valentine’s: Feb 10 – 16
  - Easter window: Mar 20 – Apr 20
  - Halloween: Oct 25 – Nov 1
- **Confetti** still fires on successful add/input actions (and some unlocks).
- Equipment / Asset **Inventory** was removed from the product.

## Themes

Client palette presets (Vanilla Cream, Blush Petal, Rosewood, Sage Leaf, Misty Sky, Midnight Lagoon) persist via `fintrack_theme` / user settings.
