/**
 * FinWise — Supabase client config (CDN / browser only)
 *
 * 1. Open https://supabase.com/dashboard → your project
 * 2. Project Settings → API
 * 3. Paste Project URL and anon public key below
 * 4. Open supabase-demo.html in the browser to test CRUD
 *
 * Never put the service_role key here (browser-visible).
 */
window.SUPABASE_CONFIG = {
  // API host that resolves (project hostname for this FinWise DB)
  url: 'https://drmeehlfsgnihdagqonk.supabase.co',

  // Publishable or legacy anon key (never service_role / secret)
  anonKey: 'sb_publishable_SyyfnYCnFRHvy5dtcd_WjQ_7Wf5eh_1',

  /** Demo CRUD table (supabase-demo.html) */
  table: 'finwise_demo',

  /** Login / Sign Up accounts table (index.html) */
  accountsTable: 'finwise_accounts'
};
