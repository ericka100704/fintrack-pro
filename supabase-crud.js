/**
 * FinWise — Supabase CRUD helpers (browser CDN SDK)
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
    return true;
  }

  function getClient() {
    if (client) return client;
    if (typeof supabase === 'undefined' || !supabase.createClient) {
      throw new Error('Supabase SDK not loaded. Include the CDN script before this file.');
    }
    if (!isConfigured()) {
      throw new Error('Set SUPABASE_CONFIG.url and SUPABASE_CONFIG.anonKey in supabase-config.js');
    }
    var cfg = getConfig();
    client = supabase.createClient(cfg.url.trim(), cfg.anonKey.trim());
    return client;
  }

  function tableName() {
    return (getConfig().table || 'finwise_demo').trim();
  }

  function fail(err) {
    if (!err) throw new Error('Unknown Supabase error');
    if (typeof err === 'string') throw new Error(err);
    throw new Error(err.message || err.details || err.hint || JSON.stringify(err));
  }

  /** CREATE — insert one row */
  async function createItem(payload) {
    var db = getClient();
    var row = {
      title: String(payload.title || '').trim(),
      amount: Number(payload.amount) || 0,
      category: String(payload.category || 'Other').trim(),
      notes: String(payload.notes || '').trim()
    };
    if (!row.title) throw new Error('Title is required.');
    var result = await db.from(tableName()).insert(row).select().single();
    if (result.error) fail(result.error);
    return result.data;
  }

  /** READ — fetch all rows (newest first) */
  async function readItems() {
    var db = getClient();
    var result = await db
      .from(tableName())
      .select('*')
      .order('created_at', { ascending: false });
    if (result.error) fail(result.error);
    return result.data || [];
  }

  /** READ one by id */
  async function readItemById(id) {
    var db = getClient();
    var result = await db.from(tableName()).select('*').eq('id', id).single();
    if (result.error) fail(result.error);
    return result.data;
  }

  /** UPDATE — edit existing row */
  async function updateItem(id, payload) {
    var db = getClient();
    var patch = {
      title: String(payload.title || '').trim(),
      amount: Number(payload.amount) || 0,
      category: String(payload.category || 'Other').trim(),
      notes: String(payload.notes || '').trim()
    };
    if (!patch.title) throw new Error('Title is required.');
    var result = await db.from(tableName()).update(patch).eq('id', id).select().single();
    if (result.error) fail(result.error);
    return result.data;
  }

  /** DELETE — remove row by id */
  async function deleteItem(id) {
    var db = getClient();
    var result = await db.from(tableName()).delete().eq('id', id).select().single();
    if (result.error) fail(result.error);
    return result.data;
  }

  global.FinWiseSupabase = {
    isConfigured: isConfigured,
    getClient: getClient,
    createItem: createItem,
    readItems: readItems,
    readItemById: readItemById,
    updateItem: updateItem,
    deleteItem: deleteItem,
    tableName: tableName
  };
})(window);
