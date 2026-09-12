# FinWise — Supabase setup (no CLI)

CDN / browser only. No terminal, no npm, no build tools.

## Files

| File | Purpose |
|------|---------|
| `supabase-config.js` | Paste your **Project URL** + **anon key** here |
| `supabase-crud.js` | Create / Read / Update / Delete helpers |
| `supabase-demo.html` | Test UI in the browser |
| `SUPABASE-SETUP.md` | This guide |

Open the demo page:

- Local file: `supabase-demo.html`
- Or XAMPP: `http://localhost/deploy-main/deploy-main/supabase-demo.html`

---

## Step 1 — Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Pick organization, name (e.g. `finwise`), set a database password, choose a region.
4. Wait until the project is ready.

---

## Step 2 — Copy URL and anon key

1. In the project sidebar: **Project Settings** (gear) → **API**.
2. Copy:
   - **Project URL**
   - **anon public** key  
3. Open `supabase-config.js` and paste:

```js
window.SUPABASE_CONFIG = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  table: 'finwise_demo'
};
```

**Do not** paste the `service_role` key into any browser file.

---

## Step 3 — Create the table (Table Editor UI)

1. Sidebar → **Table Editor** → **New table**.
2. Table name: `finwise_demo`
3. Leave **Enable Row Level Security (RLS)** ON (recommended). We will add policies next.
4. Add columns:

| Name | Type | Default | Notes |
|------|------|---------|--------|
| `id` | `uuid` | `gen_random_uuid()` | Primary key (enable “Is Identity” / PK) |
| `title` | `text` | — | Required |
| `amount` | `float8` (or `numeric`) | `0` | Money amount |
| `category` | `text` | `'Other'` | Category label |
| `notes` | `text` | `''` | Optional |
| `created_at` | `timestamptz` | `now()` | Auto timestamp |

5. Click **Save**.

### Quick SQL alternative (SQL Editor)

If you prefer one paste in **SQL Editor** → **New query**:

```sql
create table if not exists public.finwise_demo (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  amount double precision not null default 0,
  category text not null default 'Other',
  notes text not null default '',
  created_at timestamptz not null default now()
);
```

---

## Step 4 — Allow browser access (RLS policies)

Because the demo uses the **anon** key from the browser, you need policies (or temporary open access for school testing).

### Option A — Open for learning / local demo (simple)

In **SQL Editor**, run:

```sql
alter table public.finwise_demo enable row level security;

create policy "Allow anon select"
  on public.finwise_demo for select
  to anon
  using (true);

create policy "Allow anon insert"
  on public.finwise_demo for insert
  to anon
  with check (true);

create policy "Allow anon update"
  on public.finwise_demo for update
  to anon
  using (true)
  with check (true);

create policy "Allow anon delete"
  on public.finwise_demo for delete
  to anon
  using (true);
```

### Option B — UI policies

1. Open table `finwise_demo` → **RLS** / **Policies**.
2. Create policies for `SELECT`, `INSERT`, `UPDATE`, `DELETE` for role **anon** with “true” (or your preferred rules).

> For a real production app later, lock this down (auth users only, per-user rows). For now, Option A is fine for testing CRUD.

---

## Step 5 — Test CRUD in the browser

1. Save `supabase-config.js`.
2. Open `supabase-demo.html`.
3. You should see a green **Config OK** pill.
4. Try:
   - **Create** — fill the form → Save
   - **Read** — list appears / Refresh list
   - **Update** — Edit → change fields → Update row
   - **Delete** — Delete on a row

If you see an RLS / permission error, re-check Step 4.

---

## CRUD code map

| Action | Function in `supabase-crud.js` |
|--------|--------------------------------|
| Create | `FinWiseSupabase.createItem({ title, amount, category, notes })` |
| Read all | `FinWiseSupabase.readItems()` |
| Read one | `FinWiseSupabase.readItemById(id)` |
| Update | `FinWiseSupabase.updateItem(id, { ... })` |
| Delete | `FinWiseSupabase.deleteItem(id)` |

---

## Next step (FinWise app)

This demo is separate from the main `index.html` / `script.js` (still on localStorage + crudcrud).

When you are ready to migrate FinWise accounts/data to Supabase, switch to **Agent mode** and ask to wire `script.js` auth + finance tables to these helpers.
