# Clothing ERP · GitHub Pages + Supabase

Your ERP as your own website: the app is hosted free on **GitHub Pages**, and all data lives in your own **Supabase** database. Staff sign in with email and password; you give each person a role.

## Files

| File | What it is |
|---|---|
| `index.html` | The app page |
| `app.js` | The ERP itself (same features as the claude.ai version) |
| `supa-adapter.js` | Connects the app to Supabase (login, database, live updates) |
| `config.js` | **You edit this**: your Supabase URL and anon key |
| `supabase-schema.sql` | Creates the tables and security rules in Supabase |
| `zia-data-backup.json` | Your current data from the claude.ai app, ready to import |

## Step 1 · Create the Supabase database (about 5 minutes)

1. Go to <https://supabase.com>, sign up, and click **New project**. Pick a name, a strong database password, and the region closest to you (e.g. *Mumbai* or *Singapore*).
2. When the project is ready, open **SQL Editor → New query**, paste everything from `supabase-schema.sql`, and press **Run**. You should see "Success".
3. Open **Project Settings → API** and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long text starting with `eyJ…`)
4. Paste both into `config.js`.
5. Optional but easier for staff: **Authentication → Providers → Email** → turn off **Confirm email**, so new accounts can sign in straight away. Leave it on if you want every email verified.

## Step 2 · Put it on GitHub Pages

1. Sign in at <https://github.com> and click **New repository**. Name it (e.g. `zia-erp`). Public or private both work (private Pages needs a paid GitHub plan).
2. Click **uploading an existing file**, drag in `index.html`, `app.js`, `supa-adapter.js` and `config.js`, then **Commit changes**.
   Do **not** upload `zia-data-backup.json` (it contains your business data) or this README if you don't want it public.
3. Open **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
4. After a minute your app is live at `https://YOUR-USERNAME.github.io/zia-erp/`.
5. In Supabase, open **Authentication → URL Configuration** and set **Site URL** to that address (so password-reset and confirmation emails link back to your app).

## Step 3 · First sign-in and your data

1. Open your app link, click **Create an account**, and sign up. **The first account becomes the owner (Admin).**
2. Go to **Settings → Backup & data → Restore from backup** and choose `zia-data-backup.json`. Your products, sales, purchases, contacts, expenses and settings are copied in.

## Adding staff

1. Send them the app link. They click **Create an account**.
2. Their request appears in **Settings → Team & access**. Pick a role and press **Grant access**.

| Role | Can change | Sees costs / profit |
|---|---|---|
| Admin | Everything, including settings and team | Yes |
| Manager | Everything except team access | Yes |
| Sales staff | Sales, returns, contacts | No |
| Stock keeper | Purchases, products, stock adjustments, returns, contacts | Costs only |
| View only | Nothing | No |

What each role may change is enforced by the database itself (row-level security), not just hidden in the app. Anyone with a role can read the records, so only grant access to people you trust.

## Updating the app later

When you get a new version of `app.js` (or other files), upload it to the same GitHub repository to replace the old one. Your data stays in Supabase and is not affected.

## Costs

- GitHub Pages: free.
- Supabase free plan: 500 MB database, plenty for years of records for a shop. Free projects pause after 7 days with no activity; open the app (or press *Restore* in Supabase) to wake it. The Pro plan removes pausing.

## Backups

Supabase keeps the data, but still use **Settings → Download backup** every week or so and keep the file somewhere safe.
# NoorvayaERP
