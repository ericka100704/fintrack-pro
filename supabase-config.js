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
  // Example: https://abcdefghijklmnop.supabase.co
  url: 'PASTE_YOUR_SUPABASE_URL_HERE',

  // Example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  anonKey: 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE',

  /** Demo table name (create this in Table Editor — see SUPABASE-SETUP.md) */
  table: 'finwise_demo'
};
