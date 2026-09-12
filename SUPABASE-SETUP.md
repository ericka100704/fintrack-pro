# FinWise — Supabase setup (no CLI)

CDN / browser only. No terminal, no npm, no build tools.

## Files

| File | Purpose |
|------|---------|
| `supabase-config.js` | Paste your **Project URL** + **publishable/anon key** here |
| `supabase-accounts.js` | Sign In / Sign Up cloud sync (`finwise_accounts`) |
| `supabase-crud.js` | Demo Create / Read / Update / Delete helpers |
| `supabase-demo.html` | Demo test UI (not the main login) |
| `SUPABASE-SETUP.md` | This guide |

**Main app login:** open `index.html` (or your Vercel URL) — not Bing search for `supabase-demo.html`.

---

## Step 1 — Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Pick organization, name (e.g. `FinWise`), set a database password, choose a region.
4. Wait until the project is ready.

---

## Step 2 — Copy URL and key

1. Sidebar → **Project Settings** (gear) → **API**.
2. Copy:
   - **Project URL** (or from General: `https://YOUR_REF.supabase.co`)
   - **Publishable** key (`sb_publishable_…`) **or** legacy **anon** JWT (`eyJ…`)
3. Open `supabase-config.js` and paste into `url` and `anonKey`.

**Do not** paste Secret / `service_role` keys into browser files.

---

## Step 3 — Accounts table (REQUIRED for Sign In)

This powers FinWise login across phone + laptop.

**SQL Editor** → **New query** → paste → **Run**:

```sql
create table if not exists public.finwise_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  firstname text not null default '',
  lastname text not null default '',
  email text not null unique,
  phone text not null default '',
  avatar text not null default '',
  password text not null default '',
  created text not null default '',
  updated_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);

alter table public.finwise_accounts enable row level security;

create policy "Allow anon select accounts"
  on public.finwise_accounts for select
  to anon
  using (true);

create policy "Allow anon insert accounts"
  on public.finwise_accounts for insert
  to anon
  with check (true);

create policy "Allow anon update accounts"
  on public.finwise_accounts for update
  to anon
  using (true)
  with check (true);

create policy "Allow anon delete accounts"
  on public.finwise_accounts for delete
  to anon
  using (true);
```

> School/demo open policies. For production later, lock down with real Auth + per-user RLS.

After this:
1. Hard refresh FinWise (`Ctrl+F5`)
2. **Sign Up** once on phone or laptop
3. **Sign In** on the other device with the same email + password

Check rows in **Table Editor** → `finwise_accounts`.

---

## Step 4 — Optional demo table (`finwise_demo`)

Only for `supabase-demo.html` practice CRUD (separate from login).

```sql
create table if not exists public.finwise_demo (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  amount double precision not null default 0,
  category text not null default 'Other',
  notes text not null default '',
  created_at timestamptz not null default now()
);

alter table public.finwise_demo enable row level security;

create policy "Allow anon select"
  on public.finwise_demo for select to anon using (true);

create policy "Allow anon insert"
  on public.finwise_demo for insert to anon with check (true);

create policy "Allow anon update"
  on public.finwise_demo for update to anon using (true) with check (true);

create policy "Allow anon delete"
  on public.finwise_demo for delete to anon using (true);
```

Open: `supabase-demo.html` or `https://YOUR-VERCEL-URL/supabase-demo.html`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| User not found on other device | Run Step 3 SQL; Sign Up again so a row appears in `finwise_accounts` |
| permission / RLS error | Re-run the policy block for `finwise_accounts` |
| Invalid API key / JWT | Use Publishable or legacy anon key; fix Project URL typo |
| Still “quota exceeded” | Hard refresh so `script.js?v=29` loads; confirm Supabase scripts in Network tab |

---

## CRUD demo code map

| Action | Function in `supabase-crud.js` |
|--------|--------------------------------|
| Create | `FinWiseSupabase.createItem({ title, amount, category, notes })` |
| Read all | `FinWiseSupabase.readItems()` |
| Read one | `FinWiseSupabase.readItemById(id)` |
| Update | `FinWiseSupabase.updateItem(id, { ... })` |
| Delete | `FinWiseSupabase.deleteItem(id)` |
