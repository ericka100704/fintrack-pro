/**
 * FinWise — account sync via Supabase (Sign In / Sign Up)
 * Depends on: @supabase/supabase-js (CDN) + supabase-config.js
 */
(function (global) {
  'use strict';

  var client = null;

  function getConfig() {
    return global.SUPABASE_CONFIG || {};
  }

  function isConfigured() {
    var cfg = getConfig();
    var url = (cfg.url || '').trim();
    var key = (cfg.anonKey || '').trim();
    if (!url || !key) return false;
    if (/PASTE_YOUR_/i.test(url) || /PASTE_YOUR_/i.test(key)) return false;
    if (typeof supabase === 'undefined' || !supabase.createClient) return false;
    return true;
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) {
      throw new Error('Supabase not configured. Check supabase-config.js and CDN script.');
    }
    var cfg = getConfig();
    client = supabase.createClient(cfg.url.trim(), cfg.anonKey.trim(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return client;
  }

  function tableName() {
    return (getConfig().accountsTable || 'finwise_accounts').trim();
  }

  function fail(err) {
    if (!err) throw new Error('Unknown Supabase error');
    if (typeof err === 'string') throw new Error(err);
    throw new Error(err.message || err.details || err.hint || JSON.stringify(err));
  }

  function toCloudRow(row) {
    if (!row) return null;
    return {
      _id: row.id,
      id: row.id,
      username: row.username || '',
      firstname: row.firstname || '',
      lastname: row.lastname || '',
      email: row.email || '',
      phone: row.phone || '',
      avatar: row.avatar || '',
      password: row.password || '',
      created: row.created || '',
      updatedAt: row.updated_at || row.updatedAt || row.created || '',
      data: row.data || {}
    };
  }

  function toDbPayload(record) {
    return {
      username: String(record.username || '').trim(),
      firstname: String(record.firstname || '').trim(),
      lastname: String(record.lastname || '').trim(),
      email: String(record.email || '').trim().toLowerCase(),
      phone: String(record.phone || '').trim(),
      avatar: String(record.avatar || ''),
      password: String(record.password || ''),
      created: String(record.created || new Date().toISOString()),
      updated_at: String(record.updatedAt || record.updated_at || new Date().toISOString()),
      data: record.data && typeof record.data === 'object' ? record.data : {}
    };
  }

  async function listAccounts() {
    var db = getClient();
    var result = await db
      .from(tableName())
      .select('*')
      .order('updated_at', { ascending: false });
    if (result.error) fail(result.error);
    return (result.data || []).map(toCloudRow);
  }

  async function findByEmail(email) {
    var normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    var db = getClient();
    var localPart = normalized.indexOf('@') >= 0 ? normalized.split('@')[0] : normalized;
    var byEmail = await db.from(tableName()).select('*').ilike('email', normalized).limit(1);
    if (byEmail.error) fail(byEmail.error);
    if (byEmail.data && byEmail.data[0]) return toCloudRow(byEmail.data[0]);
    var byUser = await db.from(tableName()).select('*').ilike('username', localPart).limit(1);
    if (byUser.error) fail(byUser.error);
    if (byUser.data && byUser.data[0]) return toCloudRow(byUser.data[0]);
    return null;
  }

  async function upsertAccount(record, existingId) {
    var db = getClient();
    var payload = toDbPayload(record);
    if (!payload.username || !payload.email) {
      throw new Error('Username and email are required for cloud sync.');
    }

    if (existingId) {
      var updated = await db
        .from(tableName())
        .update(payload)
        .eq('id', existingId)
        .select()
        .maybeSingle();
      if (updated.error) fail(updated.error);
      if (updated.data) return toCloudRow(updated.data);
    }

    var existing = await findByEmail(payload.email);
    if (existing && existing.id) {
      var patched = await db
        .from(tableName())
        .update(payload)
        .eq('id', existing.id)
        .select()
        .single();
      if (patched.error) fail(patched.error);
      return toCloudRow(patched.data);
    }

    var inserted = await db.from(tableName()).insert(payload).select().single();
    if (inserted.error) fail(inserted.error);
    return toCloudRow(inserted.data);
  }

  /** Realtime: call onRow(cloudRow) when this email's account row changes */
  function subscribeByEmail(email, onRow) {
    var normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return Promise.reject(new Error('Email required'));
    var db = getClient();
    var channel = db
      .channel('finwise-acct-' + normalized.replace(/[^a-z0-9]/g, ''))
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: tableName(),
          filter: 'email=eq.' + normalized
        },
        function (payload) {
          var row = payload && (payload.new || payload.old);
          if (row && typeof onRow === 'function') onRow(toCloudRow(row));
        }
      )
      .subscribe();
    return Promise.resolve(channel);
  }

  function unsubscribe(channel) {
    if (!channel) return Promise.resolve();
    try {
      return getClient().removeChannel(channel);
    } catch (err) {
      return Promise.resolve();
    }
  }

  global.FinWiseAccounts = {
    isConfigured: isConfigured,
    listAccounts: listAccounts,
    findByEmail: findByEmail,
    upsertAccount: upsertAccount,
    subscribeByEmail: subscribeByEmail,
    unsubscribe: unsubscribe
  };
})(typeof window !== 'undefined' ? window : this);
