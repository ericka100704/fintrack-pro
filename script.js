/* FinWise — soft dashboard-first finance hub (localStorage + cloud accounts) */

const FT_CLOUD_UPSTREAM = 'https://crudcrud.com/api/06c45b4c02184e9785a67eea36a7d8ad/accounts';
/** Previous endpoint — read-only fallback to recover accounts if still reachable. */
const FT_CLOUD_LEGACY = 'https://crudcrud.com/api/dcc16c221e224c5b9ccb81ba43d2f5af/accounts';
const FT_CLOUD_EPOCH = '06c45b4c';
try {
  if (localStorage.getItem('fintrack_cloud_epoch') !== FT_CLOUD_EPOCH) {
    localStorage.setItem('fintrack_cloud_epoch', FT_CLOUD_EPOCH);
    localStorage.removeItem('fintrack_cloud_ids');
  }
} catch (e) { /* ignore */ }

function ftIsHostedHttps() {
  return typeof location !== 'undefined'
    && /^https?:/.test(location.protocol)
    && location.hostname !== 'localhost'
    && location.hostname !== '127.0.0.1';
}

function ftCloudBases() {
  const bases = [];
  if (ftIsHostedHttps()) bases.push(location.origin + '/api/accounts');
  bases.push(FT_CLOUD_UPSTREAM);
  return bases;
}

function ftCloudUrlForBase(base, id) {
  if (!id) return base;
  if (base.indexOf('/api/accounts') >= 0 && base.indexOf('crudcrud.com') < 0) {
    return base + '?id=' + encodeURIComponent(id);
  }
  return base + '/' + encodeURIComponent(id);
}

function ftSleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function ftLooksLikeGatewayFail(status, text) {
  if (status === 502 || status === 503 || status === 504) return true;
  const t = String(text || '').toLowerCase();
  return /bad gateway|gateway time|nginx/.test(t);
}

function ftLooksLikeQuota(status, text) {
  const t = String(text || '').toLowerCase();
  return /exceeded allowed number of requests|100 request/.test(t)
    || (status === 400 && /exceeded|quota/.test(t));
}

/** One try per base (proxy then direct). Avoid burning free-tier request quotas. */
async function ftCloudRequest(opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const id = opts.id || '';
  const body = opts.body;
  const bases = opts.bases || ftCloudBases();
  let lastErr = null;
  for (let b = 0; b < bases.length; b++) {
    const url = ftCloudUrlForBase(bases[b], id);
    try {
      const headers = { Accept: 'application/json' };
      if (body != null) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method: method, headers: headers, body: body });
      const text = await res.text();
      if (ftLooksLikeQuota(res.status, text)) {
        throw new Error('QUOTA:' + text);
      }
      if (ftLooksLikeGatewayFail(res.status, text)) {
        lastErr = new Error('Cloud sync unavailable (' + res.status + ').');
        await ftSleep(500);
        continue;
      }
      return { ok: res.ok, status: res.status, text: text, base: bases[b] };
    } catch (err) {
      if (err && String(err.message || '').indexOf('QUOTA:') === 0) throw err;
      lastErr = err;
      await ftSleep(300);
    }
  }
  throw lastErr || new Error('Cloud sync unavailable.');
}

function ftCloudBase() {
  return ftCloudBases()[0];
}

function ftCloudItemUrl(id) {
  return ftCloudUrlForBase(ftCloudBase(), id);
}

const ACCOUNT_SYSTEM = {
  _cloudSyncing: null,
  _cloudPushTimer: null,
  _lastCloudError: null,
  _lastPullAt: 0,
  _cloudIds: null,
  getUsers() {
    try { return JSON.parse(localStorage.getItem('fintrack_users')) || {}; }
    catch { return {}; }
  },
  saveUsers(users) {
    localStorage.setItem('fintrack_users', JSON.stringify(users));
  },
  getCloudIds() {
    if (this._cloudIds) return this._cloudIds;
    try { this._cloudIds = JSON.parse(localStorage.getItem('fintrack_cloud_ids')) || {}; }
    catch { this._cloudIds = {}; }
    return this._cloudIds;
  },
  saveCloudIds(map) {
    this._cloudIds = map || {};
    localStorage.setItem('fintrack_cloud_ids', JSON.stringify(this._cloudIds));
  },
  userUpdatedAt(user) {
    if (!user) return 0;
    const t = Date.parse(user.updatedAt || user.created || 0);
    return Number.isFinite(t) ? t : 0;
  },
  touchUser(user) {
    if (!user) return user;
    user.updatedAt = new Date().toISOString();
    return user;
  },
  mergeUserMaps(a, b) {
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach((key) => {
      if (!out[key]) {
        out[key] = b[key];
        return;
      }
      if (this.userUpdatedAt(b[key]) >= this.userUpdatedAt(out[key])) {
        out[key] = b[key];
      }
    });
    return out;
  },
  cloudRecordFromUser(username, user) {
    return {
      username: username,
      firstname: user.firstname || '',
      lastname: user.lastname || '',
      email: user.email || '',
      phone: user.phone || '',
      avatar: (user.avatar && String(user.avatar).length < 8000) ? user.avatar : '',
      password: user.password || '',
      created: user.created || '',
      updatedAt: user.updatedAt || user.created || new Date().toISOString(),
      data: user.data || this.emptyData()
    };
  },
  applyCloudList(list) {
    const ids = this.getCloudIds();
    const remote = {};
    (list || []).forEach((row) => {
      if (!row) return;
      const username = row.username || (row.email ? String(row.email).split('@')[0] : '');
      if (!username) return;
      if (row._id) ids[username] = row._id;
      remote[username] = {
        firstname: row.firstname || '',
        lastname: row.lastname || '',
        email: row.email || '',
        phone: row.phone || '',
        avatar: row.avatar || '',
        password: row.password || '',
        created: row.created || '',
        updatedAt: row.updatedAt || row.created || '',
        data: row.data || this.emptyData()
      };
    });
    this.saveCloudIds(ids);
    const merged = this.mergeUserMaps(this.getUsers(), remote);
    this.saveUsers(merged);
    return merged;
  },
  async fetchCloudAccounts() {
    try {
      const res = await ftCloudRequest({ method: 'GET' });
      if (!res.ok) {
        this._lastCloudError = 'Cloud sync unavailable (' + res.status + ').';
        throw new Error(this._lastCloudError);
      }
      this._lastCloudError = null;
      let list;
      try { list = JSON.parse(res.text); } catch (e) { list = []; }
      return Array.isArray(list) ? list : [];
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (msg.indexOf('QUOTA:') === 0 || /exceeded allowed number of requests|100 request/i.test(msg)) {
        this._lastCloudError = 'Cloud sync quota exceeded. Try again later or contact support.';
      } else {
        this._lastCloudError = msg || 'Cloud sync unavailable.';
      }
      throw err;
    }
  },
  async pullCloudAccounts(force) {
    const now = Date.now();
    if (!force && this._lastPullAt && (now - this._lastPullAt) < 15000) return;
    let list = [];
    try {
      list = await this.fetchCloudAccounts();
    } catch (err) {
      // Try legacy endpoint once (read-only) to recover existing accounts.
      try {
        const legacy = await ftCloudRequest({ method: 'GET', bases: [FT_CLOUD_LEGACY] });
        if (legacy.ok) {
          try { list = JSON.parse(legacy.text); } catch (e) { list = []; }
          if (!Array.isArray(list)) list = [];
          this._lastCloudError = null;
        } else {
          throw err;
        }
      } catch (legacyErr) {
        throw err;
      }
    }
    this.applyCloudList(list);
    this._lastPullAt = Date.now();
  },
  async ensureCloudSync(force) {
    if (this._cloudSyncing && !force) return this._cloudSyncing;
    const run = (async () => {
      try {
        await this.pullCloudAccounts(force);
      } catch (err) {
        // Local accounts remain usable; _lastCloudError already set when known.
      }
    })();
    this._cloudSyncing = run;
    try { await run; } finally {
      if (this._cloudSyncing === run) this._cloudSyncing = null;
    }
  },
  scheduleCloudPush(username) {
    // Intentionally no-op for routine saves — free cloud quotas burn too fast.
    // Accounts are uploaded on login/register only.
  },
  async pushUserToCloud(username) {
    const users = this.getUsers();
    const user = users[username];
    if (!user) return false;
    const body = JSON.stringify(this.cloudRecordFromUser(username, user));
    const ids = this.getCloudIds();
    const existingId = ids[username];
    try {
      if (existingId) {
        const res = await ftCloudRequest({ method: 'PUT', id: existingId, body: body });
        if (res.ok) {
          this._lastCloudError = null;
          return true;
        }
        delete ids[username];
        this.saveCloudIds(ids);
      }
      const created = await ftCloudRequest({ method: 'POST', body: body });
      if (!created.ok) {
        const errText = created.text || '';
        if (ftLooksLikeQuota(created.status, errText)) {
          this._lastCloudError = 'Cloud sync quota exceeded. Try again later or contact support.';
        } else {
          this._lastCloudError = 'Could not upload account to cloud (' + created.status + ').';
        }
        return false;
      }
      let saved = null;
      try { saved = JSON.parse(created.text); } catch (e) { saved = null; }
      if (saved && saved._id) {
        ids[username] = saved._id;
        this.saveCloudIds(ids);
      }
      this._lastCloudError = null;
      return true;
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (msg.indexOf('QUOTA:') === 0 || /exceeded allowed number of requests|100 request/i.test(msg)) {
        this._lastCloudError = 'Cloud sync quota exceeded. Try again later or contact support.';
      } else {
        this._lastCloudError = msg || 'Cloud sync failed. Check your connection and try again.';
      }
      return false;
    }
  },
  async importCloudUserByEmail(email) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    try {
      const list = await this.fetchCloudAccounts();
      this._lastPullAt = Date.now();
      const row = (list || []).find(function (item) {
        if (!item) return false;
        const rowEmail = String(item.email || '').toLowerCase();
        const rowUser = String(item.username || '').toLowerCase();
        const localPart = normalized.indexOf('@') >= 0 ? normalized.split('@')[0] : normalized;
        return rowEmail === normalized || rowUser === normalized || rowUser === localPart;
      });
      if (!row) return null;
      const username = row.username || (row.email ? String(row.email).split('@')[0] : '');
      if (!username) return null;
      this.applyCloudList([row]);
      const users = this.getUsers();
      return { username: username, user: users[username] };
    } catch (err) {
      return null;
    }
  },
  getCurrentUser() {
    try {
      const username = JSON.parse(localStorage.getItem('fintrack_current_user'));
      if (!username) return null;
      const user = this.getUsers()[username];
      if (!user) return null;
      return {
        username,
        firstname: user.firstname || username,
        lastname: user.lastname || '',
        email: user.email || username + '@email.com',
        phone: user.phone || '',
        avatar: user.avatar || ''
      };
    } catch { return null; }
  },
  setCurrentUser(username) {
    if (username) localStorage.setItem('fintrack_current_user', JSON.stringify(username));
    else localStorage.removeItem('fintrack_current_user');
  },
  defaultSettings() {
    return {
      currency: 'PHP',
      budgetLimit: 15000,
      expenseAlertThreshold: 2000,
      savingsOverallTarget: 150000,
      theme: 'soft',
      notifications: { budget: true, goals: true, achievements: true }
    };
  },
  emptyData() {
    return {
      income: [], expenses: [], savings: [], investments: [], protection: [], goals: [],
      settings: this.defaultSettings(),
      notificationsLog: []
    };
  },
  register(firstname, lastname, email, password) {
    const users = this.getUsers();
    const username = email.split('@')[0];
    if (users[username] || this.findByEmail(email)) {
      return { success: false, error: 'Email already registered! Please use a different email.' };
    }
    const passwordCheck = this.validatePassword(password);
    if (!passwordCheck.valid) return { success: false, error: passwordCheck.message };
    users[username] = {
      firstname, lastname, email,
      password: this.hashPassword(password),
      created: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: this.emptyData()
    };
    localStorage.setItem('fintrack_created_' + username, new Date().toISOString());
    this.saveUsers(users);
    return { success: true, username: username };
  },
  login(emailOrUsername, password) {
    const raw = (emailOrUsername || '').trim();
    const found = this.findByEmail(raw);
    const username = found
      ? found.username
      : (raw.indexOf('@') >= 0 ? raw.split('@')[0] : raw);
    const users = this.getUsers();
    const user = users[username] || (found && found.user);
    if (!user) return { success: false, error: 'User not found! Please check your email.' };
    if (user.password !== this.hashPassword(password)) return { success: false, error: 'Invalid password! Please try again.' };
    this.setCurrentUser(username);
    return { success: true, username: username };
  },
  logout() { this.setCurrentUser(null); },
  findByEmail(email) {
    const users = this.getUsers();
    const normalized = (email || '').trim().toLowerCase();
    for (const username of Object.keys(users)) {
      if ((users[username].email || '').toLowerCase() === normalized || username.toLowerCase() === normalized.split('@')[0]) {
        return { username, user: users[username] };
      }
    }
    return null;
  },
  resetPasswordByEmail(email, newPassword) {
    const found = this.findByEmail(email);
    if (!found) return { success: false, error: 'No account found for that email.' };
    const check = this.validatePassword(newPassword);
    if (!check.valid) return { success: false, error: check.message };
    const users = this.getUsers();
    users[found.username].password = this.hashPassword(newPassword);
    this.touchUser(users[found.username]);
    this.saveUsers(users);
    this.pushUserToCloud(found.username);
    return { success: true, username: found.username };
  },
  changePassword(username, currentPassword, newPassword) {
    const users = this.getUsers();
    const user = users[username];
    if (!user) return { success: false, error: 'User not found.' };
    if (user.password !== this.hashPassword(currentPassword)) return { success: false, error: 'Current password is incorrect.' };
    const check = this.validatePassword(newPassword);
    if (!check.valid) return { success: false, error: check.message };
    user.password = this.hashPassword(newPassword);
    this.touchUser(user);
    this.saveUsers(users);
    this.pushUserToCloud(username);
    return { success: true };
  },
  updateProfile(username, patch) {
    const users = this.getUsers();
    const user = users[username];
    if (!user) return { success: false, error: 'User not found.' };
    const next = patch || {};
    if (typeof next.firstname === 'string') {
      const fn = next.firstname.trim();
      if (!fn) return { success: false, error: 'First name is required.' };
      user.firstname = fn;
    }
    if (typeof next.lastname === 'string') user.lastname = next.lastname.trim();
    if (typeof next.phone === 'string') user.phone = next.phone.trim();
    if (typeof next.avatar === 'string') user.avatar = next.avatar;
    if (typeof next.email === 'string') {
      const email = next.email.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { success: false, error: 'Enter a valid email address.' };
      }
      const clash = Object.keys(users).some(function (key) {
        if (key === username) return false;
        return (users[key].email || '').toLowerCase() === email.toLowerCase();
      });
      if (clash) return { success: false, error: 'That email is already in use.' };
      user.email = email;
    }
    this.touchUser(user);
    this.saveUsers(users);
    this.pushUserToCloud(username);
    return { success: true };
  },
  hashPassword(password) {
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
      const char = password.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  },
  validatePassword(password) {
    let score = 0;
    const feedback = [];
    if (password.length >= 8) score++; else feedback.push('at least 8 characters');
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++; else feedback.push('uppercase and lowercase letters');
    if (/\d/.test(password)) score++; else feedback.push('at least one number');
    if (/[^a-zA-Z0-9]/.test(password)) score++; else feedback.push('at least one special character (!@#$% etc.)');
    if (score >= 3) return { valid: true, message: 'Strong password!', score };
    return { valid: false, message: 'Weak password! Add: ' + feedback.join(', '), score };
  },
  getUserData(username) {
    const user = this.getUsers()[username];
    return user ? user.data : null;
  },
  saveUserData(username, data) {
    const users = this.getUsers();
    if (!users[username]) return false;
    users[username].data = data;
    this.touchUser(users[username]);
    this.saveUsers(users);
    this.scheduleCloudPush(username);
    return true;
  },
  getSampleData() {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
    return {
      income: [
        { id: 1, desc: 'Monthly Salary', amount: 18000, type: 'Active Income', date: addDays(-3) },
        { id: 2, desc: 'Web Design Freelance', amount: 6500, type: 'Side Hustle', date: addDays(-10) },
        { id: 3, desc: 'YouTube Ad Revenue', amount: 3200, type: 'Passive Income', date: addDays(-18) }
      ],
      expenses: [
        { id: 1, desc: 'Food & Groceries', amount: 5000, category: 'Food', needWant: 'Need', mood: 'Happy', date: addDays(2), deductFrom: 'Income' },
        { id: 2, desc: 'Boarding House Rent', amount: 3800, category: 'Rent', needWant: 'Need', mood: 'Necessary', date: addDays(5), deductFrom: 'Income' },
        { id: 3, desc: 'Bike Gear', amount: 2200, category: 'Shopping', needWant: 'Want', mood: 'Treating Myself', date: addDays(-4), deductFrom: 'Income' },
        { id: 4, desc: 'Internet & Mobile', amount: 1500, category: 'Bills & Utilities', needWant: 'Need', mood: 'Stressed', date: addDays(8), deductFrom: 'Income' },
        { id: 5, desc: 'Commute', amount: 1200, category: 'Transportation', needWant: 'Need', mood: 'Stressed', date: addDays(-1), deductFrom: 'Income' }
      ],
      savings: [
        { id: 1, desc: 'Emergency Vault', amount: 4500, target: 12000, dueDate: addDays(90), account: 'Digital Bank', isCompleted: false, isEmergency: true, monthly: 1500, category: 'Emergency Fund', date: addDays(-20) },
        { id: 2, desc: '6-Month Time Deposit', amount: 5000, target: 30000, dueDate: addDays(180), account: 'Traditional Bank', isCompleted: false, isEmergency: false, monthly: 1000, category: 'Medium-Term', date: addDays(-12) },
        { id: 3, desc: 'Vacation Fund', amount: 2000, target: 20000, dueDate: addDays(200), account: 'Cash Vault', isCompleted: false, isEmergency: false, monthly: 500, category: 'Travel', date: addDays(-5) },
        { id: 4, desc: 'Laptop Downpayment', amount: 8000, target: 8000, dueDate: addDays(-30), account: 'Digital Bank', isCompleted: true, isEmergency: false, monthly: 0, category: 'Education', date: addDays(0), completedAt: addDays(0) }
      ],
      investments: [
        { id: 1, desc: 'Pag-IBIG MP2', amount: 3000, currentValue: 3250, monthly: 500, expectedReturn: 6, category: 'Stocks/Funds', date: addDays(-20) },
        { id: 2, desc: 'Index Fund', amount: 2500, currentValue: 2700, monthly: 1000, expectedReturn: 9, category: 'Stocks/Funds', date: addDays(-12) },
        { id: 3, desc: 'Small Business Stake', amount: 1500, currentValue: 1740, monthly: 0, expectedReturn: 12, category: 'Business', date: addDays(-7) }
      ],
      protection: [
        { id: 1, desc: 'Emergency Fund Buffer', amount: 50000, monthly: 1500, policyType: 'Emergency Protection', date: addDays(-30) },
        { id: 2, desc: 'PhilHealth', amount: 100000, monthly: 800, policyType: 'Health Insurance', date: addDays(-60) },
        { id: 3, desc: 'Life Cover', amount: 150000, monthly: 1200, policyType: 'Life Insurance', date: addDays(-90) }
      ],
      goals: [],
      settings: {
        currency: 'PHP',
        budgetLimit: 15000,
        expenseAlertThreshold: 2000,
        savingsOverallTarget: 150000,
        theme: 'soft',
        notifications: { budget: true, goals: true, achievements: true }
      },
      notificationsLog: []
    };
  }
};

const VIEWS = ['welcome', 'dashboard', 'income', 'spending', 'savings', 'investment', 'protection', 'analytics', 'calculator', 'settings'];
const THEME_PRESETS = [
  { id: 'soft', label: 'Soft', gradient: 'linear-gradient(135deg,#B46A72,#F7C8D3)', colors: ['#B46A72', '#F7C8D3', '#A8B58A'] },
  { id: 'rosewood', label: 'Rosewood', gradient: 'linear-gradient(135deg,#8E3B45,#2D3A47)', colors: ['#8E3B45', '#C48B93', '#2D3A47'] },
  { id: 'sage', label: 'Sage', gradient: 'linear-gradient(135deg,#6f8458,#B3BFA3)', colors: ['#6f8458', '#B3BFA3', '#7f88a8'] },
  { id: 'misty', label: 'Misty', gradient: 'linear-gradient(135deg,#6b7599,#ABB1C9)', colors: ['#6b7599', '#ABB1C9', '#B9868C'] },
  { id: 'lagoon', label: 'Lagoon', gradient: 'linear-gradient(135deg,#3D4D57,#7a8f9c)', colors: ['#3D4D57', '#7a8f9c', '#B3BFA3'] },
  { id: 'blush', label: 'Blush', gradient: 'linear-gradient(135deg,#d48a98,#F1C2CC)', colors: ['#d48a98', '#F1C2CC', '#B9868C'] }
];

const TUTORIAL_STEPS = [
  { title: 'Income', body: 'This is the Income page — record salary and side income. Remaining Balance = Income − Spending − Savings − Investments − Protection.', view: 'income' },
  { title: 'Spending', body: 'You are on the Spending page — log expenses with Needs vs Wants, and set a monthly budget in Settings for alerts.', view: 'spending' },
  { title: 'Savings', body: 'This is Savings — build reserves, mark Emergency Fund accounts, and track monthly contributions.', view: 'savings' },
  { title: 'Investments', body: 'This is the Investment page — track stocks, funds, bonds, property, crypto, gold, and other assets.', view: 'investment' },
  { title: 'Protection', body: 'You are on Protection — add health, life, property, family, disability, and emergency coverage for your safety net score.', view: 'protection' },
  { title: 'Analytics', body: 'This is Analytics — see trends, allocation, and your financial health score across pillars.', view: 'analytics' },
  { title: 'Financial Health', body: 'Back on Dashboard — your Health Score /100 averages five pillar scores so you always know the next best money move.', view: 'dashboard' }
];

const ACHIEVEMENTS = [
  { id: 'first_income', title: 'First Peso In', desc: 'Logged your first income.', emoji: '💰', test: (s) => s.income.length >= 1 },
  { id: 'first_spend', title: 'Aware Spender', desc: 'Tracked your first expense.', emoji: '🧾', test: (s) => s.expenses.length >= 1 },
  { id: 'goal_50', title: 'Halfway Hero', desc: 'Reached 50% on a savings goal.', emoji: '🎯', test: (s) => (s.savings || []).some(g => !g.isCompleted && Number(g.target) > 0 && (Number(g.amount) / Number(g.target)) >= 0.5) },
  { id: 'savings_20', title: 'Saver Streak', desc: 'Savings rate above 20%.', emoji: '🐷', test: (s) => { const inc = sum(s.income); return inc > 0 && (sum(s.savings) / inc) > 0.2; } },
  { id: 'protected', title: 'Safety Net', desc: 'Added protection coverage.', emoji: '🛡️', test: (s) => s.protection.length >= 1 },
  { id: 'investor', title: 'Seed Investor', desc: 'Added an investment.', emoji: '📈', test: (s) => s.investments.length >= 1 }
];

let state = {
  currentView: 'welcome',
  income: [], expenses: [], savings: [], investments: [], protection: [], goals: [],
  settings: ACCOUNT_SYSTEM.defaultSettings(),
  notificationsLog: [],
  readNotificationKeys: [],
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear(),
  tutorialStep: 0,
  tutorialActive: false,
  forgotUsername: null,
  sampleMode: false,
  incomePage: 1,
  incomePageSize: 5,
  savingsGrowthRange: 12,
  investGrowthRange: 12,
  protTrendRange: 12
};

let charts = {};
let confirmModalCallback = null;
let achievementQueue = [];
let achievementShowing = false;

function sum(arr, key) {
  key = key || 'amount';
  return (arr || []).reduce((s, i) => s + Number(i[key] || 0), 0);
}

function peso(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ensureMigratedData(data) {
  const base = ACCOUNT_SYSTEM.emptyData();
  const out = Object.assign(base, data || {});
  out.settings = Object.assign(ACCOUNT_SYSTEM.defaultSettings(), (data && data.settings) || {});
  out.settings.notifications = Object.assign(
    ACCOUNT_SYSTEM.defaultSettings().notifications,
    (data && data.settings && data.settings.notifications) || {}
  );
  delete out.inventory;
  out.expenses = (out.expenses || []).map(e => Object.assign({
    needWant: 'Need',
    date: todayISO(),
    category: 'Other Expenses',
    mood: 'Necessary',
    deductFrom: 'Income'
  }, e, {
    category: normalizeSpendCat(e.category || 'Other'),
    deductFrom: normalizeDeductFrom(e.deductFrom)
  }));
  out.income = (out.income || []).map(i => Object.assign({ date: todayISO(), type: 'Active Income' }, i, {
    type: normalizeIncomeType(i.type)
  }));
  out.savings = (out.savings || []).map(s => {
    const base = Object.assign({
      isEmergency: false,
      monthly: 0,
      isCompleted: false,
      date: todayISO(),
      category: 'Short-Term',
      target: 0,
      dueDate: ''
    }, s);
    if (base.isEmergency) base.category = 'Emergency Fund';
    else if (!s.category) {
      const d = String(base.desc || '').toLowerCase();
      if (/educat|school|tuition|laptop/.test(d)) base.category = 'Education';
      else if (/travel|vacation|trip/.test(d)) base.category = 'Travel';
      else if (/business|startup/.test(d)) base.category = 'Business';
      else if (/retir/.test(d)) base.category = 'Retirement';
      else if (/home|property|house/.test(d)) base.category = 'Home/Property';
      else if (/invest/.test(d)) base.category = 'Investment';
      else if (/long|mp2/.test(d)) base.category = 'Long-Term';
      else if (/medium|deposit|time/.test(d)) base.category = 'Medium-Term';
      else base.category = 'Short-Term';
    } else {
      base.category = normalizeSavCat(base.category);
    }
    if (!(Number(base.target) > 0)) {
      base.target = Math.max(Number(base.amount) || 0, (Number(base.monthly) || 0) * 6) || Number(base.amount) || 0;
    }
    if (base.isCompleted && !base.completedAt) base.completedAt = base.date || todayISO();
    return base;
  });
  out.investments = (out.investments || []).map(i => {
    const cat = normalizeInvestCat(i.category || i.expectedReturn || 'Other');
    const amount = Number(i.amount) || 0;
    const expectedReturn = Number(i.expectedReturn);
    const rate = Number.isFinite(expectedReturn) && expectedReturn >= 0
      ? expectedReturn
      : defaultInvestReturn(cat);
    let currentValue = Number(i.currentValue);
    if (!Number.isFinite(currentValue) || currentValue < 0) {
      currentValue = estimateInvestCurrentValue(amount, i.date, rate);
    }
    return Object.assign({
      date: todayISO(),
      monthly: 0,
      category: cat
    }, i, {
      category: cat,
      amount: amount,
      monthly: Number(i.monthly) || 0,
      expectedReturn: rate,
      currentValue: currentValue
    });
  });
  out.protection = (out.protection || []).map(p => Object.assign({
    date: todayISO(),
    monthly: 0,
    policyType: normalizeProtType(p.policyType)
  }, p, {
    policyType: normalizeProtType(p.policyType),
    monthly: Number(p.monthly) || 0,
    amount: Number(p.amount) || 0
  }));
  out.goals = (out.goals || []).map(g => Object.assign({ monthly: 0, dueDate: '' }, g));
  out.notificationsLog = out.notificationsLog || [];
  out.readNotificationKeys = Array.isArray(out.readNotificationKeys) ? out.readNotificationKeys : [];
  return out;
}

function normalizeIncomeType(t) {
  const s = String(t || '').trim();
  const map = {
    Active: 'Active Income',
    'Active Income': 'Active Income',
    'Side Business': 'Side Hustle',
    'Side Hustle': 'Side Hustle',
    Passive: 'Passive Income',
    'Passive Income': 'Passive Income',
    Business: 'Business',
    'Investment Income': 'Investment Income',
    Allowance: 'Allowance',
    Gifts: 'Gifts',
    'Rental Income': 'Rental Income',
    'Online Income': 'Online Income',
    'Commission & Tips': 'Commission & Tips',
    'Government Benefits': 'Government Benefits',
    Other: 'Other Income',
    'Other Income': 'Other Income'
  };
  if (map[s]) return map[s];
  const low = s.toLowerCase();
  if (/side/.test(low)) return 'Side Hustle';
  if (/passive/.test(low)) return 'Passive Income';
  if (/active/.test(low)) return 'Active Income';
  if (/commission|tips/.test(low)) return 'Commission & Tips';
  if (/government|benefit/.test(low)) return 'Government Benefits';
  if (/rental/.test(low)) return 'Rental Income';
  if (/online/.test(low)) return 'Online Income';
  if (/invest/.test(low)) return 'Investment Income';
  if (/allowance/.test(low)) return 'Allowance';
  if (/gift/.test(low)) return 'Gifts';
  if (/business/.test(low)) return 'Business';
  return 'Other Income';
}

function normalizeSpendCat(c) {
  const s = String(c || '').trim();
  const map = {
    Food: 'Food',
    Transportation: 'Transportation',
    Bills: 'Bills & Utilities',
    'Bills & Utilities': 'Bills & Utilities',
    Health: 'Healthcare',
    Healthcare: 'Healthcare',
    Education: 'Education',
    Shopping: 'Shopping',
    Entertainment: 'Entertainment',
    Gifts: 'Gifts',
    'Debt Payments': 'Debt Payments',
    'Donations & Charity': 'Donations & Charity',
    Pets: 'Pets',
    Emergency: 'Emergency',
    Rent: 'Rent',
    Other: 'Other Expenses',
    Others: 'Other Expenses',
    'Other Expenses': 'Other Expenses'
  };
  if (map[s]) return map[s];
  const low = s.toLowerCase();
  if (/bill|utilit/.test(low)) return 'Bills & Utilities';
  if (/health/.test(low)) return 'Healthcare';
  if (/debt/.test(low)) return 'Debt Payments';
  if (/donat|charity/.test(low)) return 'Donations & Charity';
  if (/pet/.test(low)) return 'Pets';
  if (/emergenc/.test(low)) return 'Emergency';
  if (/rent/.test(low)) return 'Rent';
  return 'Other Expenses';
}

function normalizeDeductFrom(v) {
  const s = String(v || '').trim();
  const allowed = ['Income', 'Savings', 'Investment', 'Business', 'Emergency Fund', 'Protection', 'Other'];
  if (allowed.indexOf(s) >= 0) return s;
  const low = s.toLowerCase();
  if (/emergenc/.test(low)) return 'Emergency Fund';
  if (/invest/.test(low)) return 'Investment';
  if (/sav/.test(low)) return 'Savings';
  if (/business/.test(low)) return 'Business';
  if (/protect/.test(low)) return 'Protection';
  if (/income/.test(low)) return 'Income';
  return 'Income';
}

function normalizeSavCat(c) {
  const s = String(c || '').trim();
  if (!s) return 'Short-Term';
  const map = {
    'Short-Term': 'Short-Term',
    'Medium Savings': 'Medium-Term',
    'Medium-Term': 'Medium-Term',
    'Long-Term': 'Long-Term',
    Emergency: 'Emergency Fund',
    'Emergency Fund': 'Emergency Fund',
    Education: 'Education',
    Travel: 'Travel',
    Business: 'Business',
    Investment: 'Investment',
    'Home/Property': 'Home/Property',
    Retirement: 'Retirement',
    Other: 'Other'
  };
  if (map[s]) return map[s];
  const low = s.toLowerCase();
  if (/emergenc/.test(low)) return 'Emergency Fund';
  if (/medium/.test(low)) return 'Medium-Term';
  if (/long/.test(low)) return 'Long-Term';
  if (/short/.test(low)) return 'Short-Term';
  if (/educat/.test(low)) return 'Education';
  if (/travel/.test(low)) return 'Travel';
  if (/business/.test(low)) return 'Business';
  if (/invest/.test(low)) return 'Investment';
  if (/home|property/.test(low)) return 'Home/Property';
  if (/retir/.test(low)) return 'Retirement';
  return 'Other';
}

function isBillCategory(cat) {
  const c = normalizeSpendCat(cat);
  return c === 'Bills & Utilities' || c === 'Rent';
}

function normalizeInvestCat(c) {
  const map = {
    'Stocks/Funds': 'Stocks/Funds',
    'Business Investment': 'Business',
    'Business': 'Business',
    'Bonds/Fixed income': 'Bonds/Fixed Income',
    'Bonds/Fixed Income': 'Bonds/Fixed Income',
    'Property': 'Property',
    'Retirement': 'Retirement Investment',
    'Retirement Investment': 'Retirement Investment',
    'Mutual Funds/ETFs': 'Mutual Funds / ETFs',
    'Mutual Funds / ETFs': 'Mutual Funds / ETFs',
    'Cryptocurrency': 'Cryptocurrency',
    'Crypto': 'Cryptocurrency',
    'Gold / Precious Metals': 'Gold / Precious Metals',
    'Gold/Precious Metals': 'Gold / Precious Metals',
    'Cash/Short-Term': 'Other',
    'Cash': 'Other',
    'Other': 'Other',
    'Other Investment': 'Other'
  };
  if (map[c]) return map[c];
  const low = String(c || '').toLowerCase();
  if (/mutual|etf/.test(low)) return 'Mutual Funds / ETFs';
  if (/crypto/.test(low)) return 'Cryptocurrency';
  if (/gold|precious/.test(low)) return 'Gold / Precious Metals';
  if (/retir/.test(low)) return 'Retirement Investment';
  if (/stock|fund/.test(low)) return 'Stocks/Funds';
  if (/bond/.test(low)) return 'Bonds/Fixed Income';
  if (/business/.test(low)) return 'Business';
  if (/propert/.test(low)) return 'Property';
  if (/cash/.test(low)) return 'Other';
  return 'Other';
}

function defaultInvestReturn(cat) {
  const rates = {
    'Stocks/Funds': 8,
    'Business': 12,
    'Bonds/Fixed Income': 4,
    'Property': 6,
    'Retirement Investment': 7,
    'Mutual Funds / ETFs': 8,
    'Cryptocurrency': 15,
    'Gold / Precious Metals': 5,
    'Other': 5
  };
  return rates[cat] || 5;
}

function estimateInvestCurrentValue(amount, dateStr, annualPct) {
  const amt = Number(amount) || 0;
  if (amt <= 0) return 0;
  const start = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(start.getTime())) return amt;
  const years = Math.max(0, (Date.now() - start.getTime()) / (365.25 * 24 * 3600 * 1000));
  const rate = (Number(annualPct) || 0) / 100;
  return Math.round(amt * (1 + rate * years) * 100) / 100;
}

function normalizeProtType(t) {
  if (!t) return 'Insurance Coverage';
  const s = String(t);
  if (/personal\s*accident/i.test(s) || /accident/i.test(s)) return 'Personal Accident Insurance';
  if (/disabilit/i.test(s)) return 'Disability Insurance';
  if (/family/i.test(s)) return 'Family Insurance';
  if (/emergency/i.test(s)) return 'Emergency Protection';
  if (/health/i.test(s)) return 'Health Insurance';
  if (/life/i.test(s)) return 'Life Insurance';
  if (/proper|property/i.test(s)) return 'Property Insurance';
  if (/other/i.test(s)) return 'Other Protection';
  if (/insurance/i.test(s)) return 'Insurance Coverage';
  return 'Insurance Coverage';
}

/* ---------- Totals & scoring ---------- */
function totals() {
  const income = sum(state.income);
  const spending = sum(state.expenses);
  const savings = sum(state.savings);
  const investments = sum(state.investments);
  const protection = sum(state.protection);
  // Protection amounts are coverage values, not cash outflows — exclude from remaining balance
  const remaining = income - spending - savings - investments;
  const savingsRate = income > 0 ? (savings / income) * 100 : 0;
  const spendingRatio = income > 0 ? (spending / income) * 100 : 0;
  const monthlySpend = spending;
  const ef = state.savings.filter(s => s.isEmergency).reduce((a, s) => a + Number(s.amount), 0)
    + state.protection.filter(p => /emergency/i.test(String(p.policyType || ''))).reduce((a, p) => a + Number(p.amount), 0);
  const efMonths = monthlySpend > 0 ? ef / monthlySpend : (ef > 0 ? 99 : 0);
  return { income, spending, savings, investments, protection, remaining, savingsRate, spendingRatio, ef, efMonths };
}

/** True when the user has at least one real finance entry. */
function hasFinancialData() {
  return state.income.length > 0
    || state.expenses.length > 0
    || state.savings.length > 0
    || state.investments.length > 0
    || state.protection.length > 0;
}

/** Encouraging 6-month projected net-worth series from current assets + surplus. */
function buildNetWorthTrend(t) {
  if (!hasFinancialData()) return [0, 0, 0, 0, 0, 0];
  const assets = Math.max(0, t.savings + t.investments);
  const cashflow = t.income - t.spending;
  const monthlyGrow = Math.max(
    cashflow * 0.3,
    t.savings * 0.06 + t.investments * 0.04,
    assets > 0 ? assets * 0.05 : 1200
  );
  const start = assets > 0 ? assets : Math.max(cashflow, 2500);
  return Array.from({ length: 6 }, (_, i) => Math.round(start + monthlyGrow * (i + 1)));
}

function buildSavingsTrend(t) {
  if (!hasFinancialData()) return [0, 0, 0, 0, 0, 0];
  const base = Math.max(0, t.savings);
  const step = Math.max(base * 0.08, t.income > 0 ? t.income * 0.04 : 600);
  const start = base > 0 ? base : step;
  return Array.from({ length: 6 }, (_, i) => Math.round(start + step * (i + 1)));
}

function chartAreaGradient(context, topRgba, bottomRgba) {
  const chart = context.chart;
  const { ctx, chartArea } = chart;
  if (!chartArea) return topRgba;
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, topRgba);
  gradient.addColorStop(1, bottomRgba);
  return gradient;
}

function pillarScores() {
  if (!hasFinancialData()) {
    return { income: 0, savings: 0, spending: 0, investment: 0, protection: 0 };
  }
  const t = totals();
  const incomeScore = t.income <= 0
    ? 0
    : Math.min(100, 40 + Math.min(60, (t.income / 25000) * 60));
  const savingsScore = t.savings <= 0
    ? 0
    : Math.min(100, t.savingsRate >= 20 ? 90 : t.savingsRate >= 10 ? 70 : 45);
  // No spending yet with income = healthy blank slate (not a fake 90% ring on Allocation)
  const spendingScore = t.spending <= 0
    ? (t.income > 0 ? 100 : 0)
    : Math.min(100, t.spendingRatio <= 50 ? 90 : t.spendingRatio <= 70 ? 65 : t.spendingRatio <= 90 ? 40 : 20);
  const investScore = t.investments <= 0
    ? 0
    : Math.min(100, t.income > 0 ? 40 + Math.min(60, (t.investments / t.income) * 100) : 50);
  const types = new Set(state.protection.map(function (p) { return normalizeProtType(p.policyType); }));
  const protScore = state.protection.length === 0
    ? 0
    : Math.min(100, Math.round((types.size / 9) * 80) + (t.efMonths >= 3 ? 20 : t.efMonths >= 1 ? 10 : 0));
  return {
    income: Math.round(incomeScore),
    savings: Math.round(savingsScore),
    spending: Math.round(spendingScore),
    investment: Math.round(investScore),
    protection: Math.round(protScore)
  };
}

function healthScore() {
  if (!hasFinancialData()) return 0;
  const p = pillarScores();
  return Math.round((p.income + p.savings + p.spending + p.investment + p.protection) / 5);
}

function healthBandLabel(score) {
  if (!hasFinancialData()) return 'No data yet';
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  if (score >= 30) return 'Building';
  return 'Getting Started';
}

function progressEncouragement(score) {
  if (!hasFinancialData()) return 'Add income or load sample data to unlock your snapshot.';
  if (score >= 85) return "You're crushing it this month.";
  if (score >= 70) return "You're making great progress this month.";
  if (score >= 50) return "You're building solid habits this month.";
  if (score >= 30) return "You're taking steps forward this month.";
  return "You're getting started — keep going this month.";
}

function pillarFocusCopy() {
  if (!hasFinancialData()) return '';
  const p = pillarScores();
  const labels = {
    income: 'Income',
    savings: 'Savings',
    spending: 'Spending',
    investment: 'Investment',
    protection: 'Protection'
  };
  const entries = Object.keys(labels).map(k => ({ key: k, label: labels[k], score: p[k] }));
  entries.sort((a, b) => b.score - a.score);
  const strongest = entries[0];
  const focus = entries[entries.length - 1];
  if (strongest.key === focus.key) {
    return 'Keep nurturing every pillar — balance is your next win.';
  }
  return 'Strongest: ' + strongest.label + ' · Focus: ' + focus.label;
}

function formatFirstName(user) {
  if (!user) return 'there';
  let raw = (user.firstname || user.firstName || user.fullName || user.name || '').trim();
  // Never greet with an email address
  if (!raw || raw.includes('@')) {
    const local = String(user.username || user.email || '').split('@')[0].trim();
    raw = local || 'there';
  }
  const first = raw.split(/[\s._-]+/)[0];
  if (!first || first === 'there') return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function timeOfDayLabel() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function healthTipsList() {
  if (!hasFinancialData()) {
    return [
      { icon: 'wallet', title: 'Track Your Expenses', desc: 'Log spending to see where money goes.' },
      { icon: 'piggy-bank', title: 'Set a Savings Goal', desc: 'Start small — consistency builds safety.' },
      { icon: 'line-chart', title: 'Grow Your Investments', desc: 'Add investments once basics are covered.' }
    ];
  }
  const p = pillarScores();
  const tips = [];
  if (p.spending < 70) tips.push({ icon: 'credit-card', title: 'Tighten Spending', desc: 'Review wants and trim one category this week.' });
  else tips.push({ icon: 'wallet', title: 'Track Your Expenses', desc: 'Spending looks controlled — keep logging.' });
  if (p.savings < 70) tips.push({ icon: 'piggy-bank', title: 'Set a Savings Goal', desc: 'Boost savings rate toward 20% of income.' });
  else tips.push({ icon: 'piggy-bank', title: 'Keep Saving', desc: 'Strong savings habit — protect the streak.' });
  if (p.investment < 70) tips.push({ icon: 'line-chart', title: 'Grow Your Investments', desc: 'Put spare cash into long-term growth.' });
  else tips.push({ icon: 'shield-check', title: 'Strengthen Protection', desc: 'Review coverage gaps for peace of mind.' });
  return tips.slice(0, 3);
}

function renderFinancialHealthPanel() {
  const tipsEl = document.getElementById('dash-health-tips');
  if (!tipsEl) return;
  tipsEl.innerHTML = healthTipsList().map(function (t) {
    return '<div class="dash-health-tip">'
      + '<div class="dash-health-tip-icon"><i data-lucide="' + t.icon + '"></i></div>'
      + '<div class="dash-health-tip-copy"><strong>' + t.title + '</strong><span>' + t.desc + '</span></div>'
      + '<i data-lucide="chevron-right" class="dash-health-tip-chevron"></i>'
      + '</div>';
  }).join('');
}

function moneyPersonality() {
  const t = totals();
  if (t.income === 0) return { title: 'Fresh Starter', desc: 'Add income to unlock a clearer money personality.' };
  if (t.savingsRate >= 25 && t.investments > 0) return { title: 'Builder', desc: 'You save and invest — compounding is your friend.' };
  if (t.spendingRatio > 70) return { title: 'Lifestyle Spender', desc: 'Spending runs hot. Trim wants and set a firmer budget.' };
  if (t.efMonths >= 3) return { title: 'Safety-First', desc: 'Emergency buffer looks solid. Time to grow investments.' };
  if (t.savingsRate >= 15) return { title: 'Steady Saver', desc: 'Healthy savings habit. Push a little more into goals.' };
  return { title: 'Balanced Explorer', desc: 'You are finding your rhythm across the five pillars.' };
}

function nextBestAction() {
  const t = totals();
  const p = pillarScores();
  if (t.income === 0) return 'Add your first income stream to unlock Remaining Balance and scores.';
  if (t.efMonths < 1) return 'Start or grow an Emergency Fund (Savings or Protection) toward 1+ month of spending.';
  if (t.spendingRatio > 70) return 'Review Needs vs Wants — cut one Want category this week.';
  if (p.protection < 50) return 'Add Health or Life coverage to strengthen your Protection score.';
  if ((state.savings || []).filter(function (s) { return !s.isCompleted; }).length === 0) return 'Create a savings goal with a target date so the mini calendar can guide you.';
  if (t.savingsRate < 20) return 'Raise monthly savings toward a 20%+ rate for the Saver Streak achievement.';
  return 'You are on track — review Analytics and keep logging weekly.';
}

function buildInsights() {
  const t = totals();
  const list = [];
  list.push('Savings rate: ' + t.savingsRate.toFixed(1) + '% of income.');
  list.push('Spending uses ' + t.spendingRatio.toFixed(1) + '% of income.');
  list.push('Emergency coverage ≈ ' + (t.efMonths >= 99 ? '∞' : t.efMonths.toFixed(1)) + ' months of spending.');
  const wants = state.expenses.filter(e => e.needWant === 'Want');
  if (wants.length) list.push('Wants total ' + peso(sum(wants)) + ' — opportunity to redirect.');
  else list.push('No Want expenses logged yet — keep categorizing.');
  return list;
}

function buildNotifications() {
  const t = totals();
  const notes = [];
  const budget = Number(state.settings.budgetLimit || 0);
  if (state.settings.notifications.budget && budget > 0 && t.spending >= budget * 0.9) {
    notes.push({
      id: 'budget-spend',
      level: 'warn',
      action: 'spending',
      text: 'Spending is at ' + Math.round((t.spending / budget) * 100) + '% of your ₱' + budget.toLocaleString() + ' budget.'
    });
  }
  if (state.settings.notifications.goals) {
    (state.savings || []).filter(function (s) { return !s.isCompleted; }).forEach(function (g) {
      const targetAmt = Number(g.target) > 0 ? Number(g.target) : 0;
      const pct = targetAmt > 0 ? Math.round((Number(g.amount) / targetAmt) * 100) : 0;
      if (g.dueDate) {
        const days = Math.ceil((new Date(g.dueDate) - new Date()) / 86400000);
        if (days >= 0 && days <= 14) {
          notes.push({
            id: 'goal-due-' + g.id,
            level: 'info',
            action: 'savings',
            text: 'Goal "' + g.desc + '" due in ' + days + ' day(s) — ' + pct + '% done.'
          });
        }
      }
      if (pct >= 100) {
        notes.push({
          id: 'goal-done-' + g.id,
          level: 'ok',
          action: 'savings',
          text: 'Goal "' + g.desc + '" reached!'
        });
      }
    });
  }
  state.expenses.forEach(e => {
    if (e.date && e.needWant === 'Need' && isBillCategory(e.category)) {
      const days = Math.ceil((new Date(e.date) - new Date()) / 86400000);
      if (days >= 0 && days <= 10) {
        notes.push({
          id: 'bill-' + e.id,
          level: 'info',
          action: e.category === 'Rent' ? 'calendar' : 'spending',
          text: 'Upcoming ' + e.category + ': ' + e.desc + ' on ' + e.date + '.'
        });
      }
    }
  });
  if (!notes.length) {
    notes.push({ id: 'quiet', level: 'ok', action: 'dashboard', text: 'All quiet — no urgent alerts right now.' });
  }
  return notes;
}

/* ---------- Theme & seasonal ---------- */
function getStoredTheme() {
  return localStorage.getItem('fintrack_theme') || (state.settings && state.settings.theme) || 'soft';
}

function setTheme(theme) {
  if (!THEME_PRESETS.find(function (t) { return t.id === theme; })) theme = 'soft';
  const prev = getStoredTheme();
  localStorage.setItem('fintrack_theme', theme);
  if (state.settings) state.settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
  applySeasonalAccent();
  renderThemePresets();
  updateCharts();
  if (ACCOUNT_SYSTEM.getCurrentUser()) saveUserData();
  if (prev !== theme) {
    const preset = THEME_PRESETS.find(function (t) { return t.id === theme; });
    showToast('Theme applied: ' + (preset ? preset.label : theme), 'success');
  }
}

function getStoredColorMode() {
  return localStorage.getItem('fintrack_color_mode') || 'light';
}

function setColorMode(mode) {
  mode = mode === 'dark' ? 'dark' : 'light';
  localStorage.setItem('fintrack_color_mode', mode);
  document.body.setAttribute('data-mode', mode);
  const icon = document.getElementById('mode-toggle-icon');
  if (icon) {
    icon.setAttribute('data-lucide', mode === 'dark' ? 'sun' : 'moon');
    if (window.lucide) lucide.createIcons();
  }
  const btn = document.getElementById('mode-toggle-btn');
  if (btn) btn.title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  updateCharts();
}

function toggleColorMode() {
  setColorMode(getStoredColorMode() === 'dark' ? 'light' : 'dark');
}

let landingRevealObserver = null;
function initLandingScrollReveal() {
  const section = document.getElementById('landing-how');
  if (!section) return;
  section.classList.remove('is-visible');
  if (landingRevealObserver) {
    landingRevealObserver.disconnect();
    landingRevealObserver = null;
  }
  landingRevealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        landingRevealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
  landingRevealObserver.observe(section);
}

function getSeasonalMode() {
  const mode = localStorage.getItem('fintrack_season_mode') || 'auto';
  const allowed = ['auto', 'off', 'christmas', 'valentines', 'easter', 'halloween'];
  return allowed.indexOf(mode) >= 0 ? mode : 'auto';
}

function setSeasonalMode(mode) {
  const allowed = ['auto', 'off', 'christmas', 'valentines', 'easter', 'halloween'];
  if (allowed.indexOf(mode) < 0) mode = 'auto';
  localStorage.setItem('fintrack_season_mode', mode);
  // Calendar always follows real time — seasonal preview is look-only
  if (typeof state !== 'undefined') {
    const now = new Date();
    state.calMonth = now.getMonth();
    state.calYear = now.getFullYear();
  }
  applySeasonalAccent();
  const labels = {
    auto: 'Seasonal accents: Auto (by date)',
    off: 'Seasonal accents off',
    christmas: 'Preview: Christmas accents',
    valentines: 'Preview: Valentine’s accents',
    easter: 'Preview: Easter accents',
    halloween: 'Preview: Halloween accents'
  };
  showToast(labels[mode] || 'Seasonal accents updated', 'success');
  if (typeof lucide !== 'undefined') lucide.createIcons();
  if (typeof updateCharts === 'function') updateCharts();
}

function detectSeasonFromDate(d) {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // Christmas Dec 15 – Jan 5
  if ((m === 12 && day >= 15) || (m === 1 && day <= 5)) return 'christmas';
  // Valentine’s Feb 10 – 16
  if (m === 2 && day >= 10 && day <= 16) return 'valentines';
  // Easter window Mar 20 – Apr 20
  if ((m === 3 && day >= 20) || (m === 4 && day <= 20)) return 'easter';
  // Halloween Oct 25 – Nov 1
  if ((m === 10 && day >= 25) || (m === 11 && day <= 1)) return 'halloween';
  return null;
}

function getEasterSunday(year) {
  // Anonymous Gregorian algorithm — returns { month: 0-based, day }
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month: month, day: day };
}

function applySeasonalAccent() {
  const seasons = ['christmas', 'valentines', 'easter', 'halloween'];
  seasons.forEach(function (s) {
    document.body.classList.remove('season-' + s);
    document.documentElement.classList.remove('season-' + s);
  });
  document.body.removeAttribute('data-season');
  document.documentElement.removeAttribute('data-season');

  const mode = getSeasonalMode();
  const select = document.getElementById('seasonal-accent-select');
  if (select && select.value !== mode) select.value = mode;

  let season = null;
  if (mode === 'off') season = null;
  else if (mode === 'auto') season = detectSeasonFromDate(new Date());
  else season = mode;

  const badge = document.getElementById('seasonal-badge');
  const header = document.querySelector('.ft-header');
  const labels = {
    christmas: 'Christmas Edition',
    valentines: "Valentine's Edition",
    easter: '🥚 Easter Edition',
    halloween: '🎃 Halloween Edition'
  };

  if (season && labels[season]) {
    document.body.classList.add('season-' + season);
    document.documentElement.classList.add('season-' + season);
    document.body.setAttribute('data-season', season);
    document.documentElement.setAttribute('data-season', season);
    if (header) header.classList.add('season-decor');
    if (badge) {
      badge.textContent = labels[season];
      badge.classList.remove('hidden');
    }
  } else {
    document.documentElement.removeAttribute('data-season');
    if (header) header.classList.remove('season-decor');
    if (badge) {
      badge.textContent = '';
      badge.classList.add('hidden');
    }
  }

  const isVday = season === 'valentines';
  const isXmas = season === 'christmas';
  const isEaster = season === 'easter';
  const isHalloween = season === 'halloween';
  document.querySelectorAll('.vday-only').forEach(function (el) {
    if (isVday) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  document.querySelectorAll('.xmas-only').forEach(function (el) {
    if (isXmas) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  document.querySelectorAll('.easter-only').forEach(function (el) {
    if (isEaster) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  document.querySelectorAll('.halloween-only').forEach(function (el) {
    if (isHalloween) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  document.querySelectorAll('.vday-hide-on-vday').forEach(function (el) {
    el.style.display = isVday ? 'none' : '';
  });

  const quoteText = document.querySelector('#sidebar .sidebar-quote-text');
  if (quoteText) {
    if (isVday) quoteText.textContent = 'Better Financial Choices Today, A Brighter Tomorrow';
    else if (isXmas) quoteText.textContent = 'May your financial goals become your best gifts this Christmas!';
    else if (isEaster) quoteText.textContent = 'Small steps today, bigger dreams tomorrow.';
    else if (isHalloween) quoteText.textContent = 'Spooky savings today, brighter tomorrows!';
    else quoteText.textContent = 'Small changes today, big financial wins tomorrow. ♡';
  }

  const bannerTitle = document.getElementById('vday-cal-banner-title');
  const bannerBody = document.getElementById('vday-cal-banner-body');
  if (bannerTitle && bannerBody && isVday) {
    const now = new Date();
    const isRealVday = now.getMonth() === 1 && now.getDate() === 14;
    if (isRealVday) {
      bannerTitle.textContent = "Today is Valentine's Day";
      bannerBody.textContent = 'A great day to celebrate the love you have for your future self! ♥';
    } else if (mode !== 'auto') {
      bannerTitle.textContent = "Valentine's Season";
      bannerBody.textContent = 'Theme preview only — calendar follows today’s real date. ♥';
    } else {
      bannerTitle.textContent = "Valentine's Season";
      bannerBody.textContent = 'A great day to celebrate the love you have for your future self! ♥';
    }
  }

  const xmasTitle = document.getElementById('xmas-cal-banner-title');
  const xmasBody = document.getElementById('xmas-cal-banner-body');
  if (xmasTitle && xmasBody && isXmas) {
    const now = new Date();
    const isRealXmas = now.getMonth() === 11 && now.getDate() === 25;
    if (isRealXmas) {
      xmasTitle.textContent = 'Merry Christmas!';
      xmasBody.textContent = 'May your financial goals become your best gifts this Christmas!';
    } else if (mode !== 'auto') {
      xmasTitle.textContent = 'Christmas Season';
      xmasBody.textContent = 'Theme preview only — calendar follows today’s real date. 🎄';
    } else {
      xmasTitle.textContent = 'Christmas Season';
      xmasBody.textContent = 'May your financial goals become your best gifts this Christmas!';
    }
  }

  const easterTitle = document.getElementById('easter-cal-banner-title');
  const easterBody = document.getElementById('easter-cal-banner-body');
  if (easterTitle && easterBody && isEaster) {
    const now = new Date();
    const easter = getEasterSunday(now.getFullYear());
    const isRealEaster = now.getMonth() === easter.month && now.getDate() === easter.day;
    if (isRealEaster) {
      easterTitle.textContent = 'Happy Easter!';
      easterBody.textContent = 'May this season bring renewed strength, peace, and financial blessings.';
    } else if (mode !== 'auto') {
      easterTitle.textContent = 'Easter Season';
      easterBody.textContent = 'Theme preview only — calendar follows today’s real date.';
    } else {
      easterTitle.textContent = 'Easter Season';
      easterBody.textContent = 'Small steps today, bigger dreams tomorrow.';
    }
  }

  const halloTitle = document.getElementById('halloween-cal-banner-title');
  const halloBody = document.getElementById('halloween-cal-banner-body');
  if (halloTitle && halloBody && isHalloween) {
    const now = new Date();
    const isRealHallo = now.getMonth() === 9 && now.getDate() === 31;
    if (isRealHallo) {
      halloTitle.textContent = 'Happy Halloween!';
      halloBody.textContent = 'Keep your financial goals as your superpower tonight!';
    } else if (mode !== 'auto') {
      halloTitle.textContent = 'Halloween Season';
      halloBody.textContent = 'Theme preview only — calendar follows today’s real date.';
    } else {
      halloTitle.textContent = 'Halloween is coming!';
      halloBody.textContent = 'Keep your financial goals as your superpower!';
    }
  }

  // Refresh dash greeting / charts for season skin (calendar stays on real current month)
  if (typeof updateSummaryMetrics === 'function' && document.getElementById('dash-greeting') && ACCOUNT_SYSTEM.getCurrentUser()) {
    try { updateSummaryMetrics(); } catch (e) { /* boot */ }
  } else if (typeof updateCharts === 'function') {
    try { updateCharts(); } catch (e) { /* boot */ }
  }
  if (typeof renderMiniCalendar === 'function') {
    try { renderMiniCalendar(); } catch (e) { /* boot */ }
  }
}

function renderThemePresets() {
  const wrap = document.getElementById('theme-presets');
  if (!wrap) return;
  const current = getStoredTheme();
  wrap.innerHTML = THEME_PRESETS.map(function (t) {
    const isSoft = t.id === 'soft';
    const label = isSoft ? 'Soft (Default)' : t.label;
    const active = t.id === current;
    return '<button type="button" class="settings-theme-card' + (active ? ' is-active' : '') + '" onclick="setTheme(\'' + t.id + '\')" aria-pressed="' + (active ? 'true' : 'false') + '">'
      + '<span class="settings-theme-preview" style="background:' + t.gradient + '"></span>'
      + '<span class="settings-theme-label">' + escapeHtml(label) + '</span>'
      + (active ? '<span class="settings-theme-check" aria-hidden="true"><i data-lucide="check"></i></span>' : '')
      + '</button>';
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

/* ---------- Auth UI ---------- */
function lockBodyScroll() {
  document.body.classList.add('modal-open');
  document.documentElement.classList.add('modal-open');
}
function unlockBodyScrollIfIdle() {
  const ids = ['login-modal', 'forgot-modal', 'confirm-modal', 'profile-edit-modal', 'income-modal', 'income-delete-modal', 'expense-modal', 'expense-delete-modal', 'budget-limit-modal', 'expense-alert-modal', 'savings-modal', 'savings-goal-modal', 'savings-target-modal', 'savings-delete-modal', 'investment-modal', 'investment-delete-modal', 'protection-modal', 'protection-delete-modal'];
  const anyOpen = ids.some(function (id) {
    const el = document.getElementById(id);
    return el && el.style.display === 'flex';
  });
  if (!anyOpen) {
    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');
  }
}

function showLoginModal() {
  document.getElementById('login-modal').style.display = 'flex';
  lockBodyScroll();
  switchLoginTab('login');
  lucide.createIcons();
}
function closeLoginModal() {
  document.getElementById('login-modal').style.display = 'none';
  unlockBodyScrollIfIdle();
}
function switchLoginTab(tab) {
  const loginBtn = document.getElementById('login-tab-btn');
  const registerBtn = document.getElementById('register-tab-btn');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const loginFooter = document.getElementById('login-footer');
  const registerFooter = document.getElementById('register-footer');
  if (tab === 'login') {
    loginBtn.classList.add('active'); registerBtn.classList.remove('active');
    loginForm.classList.add('active'); registerForm.classList.remove('active');
    loginFooter.style.display = 'block'; registerFooter.style.display = 'none';
  } else {
    registerBtn.classList.add('active'); loginBtn.classList.remove('active');
    registerForm.classList.add('active'); loginForm.classList.remove('active');
    loginFooter.style.display = 'none'; registerFooter.style.display = 'block';
  }
  lucide.createIcons();
}
function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const btn = input.parentElement && input.parentElement.querySelector('.password-toggle');
  if (!btn) return;
  const revealing = input.type === 'password';
  input.type = revealing ? 'text' : 'password';
  btn.innerHTML = '';
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', revealing ? 'eye-off' : 'eye');
  icon.className = 'w-4 h-4';
  btn.appendChild(icon);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openForgotPassword() {
  closeLoginModal();
  state.forgotUsername = null;
  document.getElementById('forgot-step-email').classList.remove('hidden');
  document.getElementById('forgot-step-reset').classList.add('hidden');
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-new-password').value = '';
  document.getElementById('forgot-confirm-password').value = '';
  document.getElementById('forgot-modal').style.display = 'flex';
  lockBodyScroll();
  lucide.createIcons();
}
function closeForgotPassword() {
  document.getElementById('forgot-modal').style.display = 'none';
  unlockBodyScrollIfIdle();
}
async function forgotLookupEmail() {
  const email = document.getElementById('forgot-email').value.trim();
  await ACCOUNT_SYSTEM.ensureCloudSync();
  const found = ACCOUNT_SYSTEM.findByEmail(email);
  if (!found) { showToast('No account found for that email.', 'rose'); return; }
  state.forgotUsername = found.username;
  document.getElementById('forgot-found-email').textContent = found.user.email || email;
  document.getElementById('forgot-step-email').classList.add('hidden');
  document.getElementById('forgot-step-reset').classList.remove('hidden');
  lucide.createIcons();
}
function forgotResetPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  const pass = document.getElementById('forgot-new-password').value;
  const confirm = document.getElementById('forgot-confirm-password').value;
  if (pass !== confirm) { showToast('Passwords do not match.', 'rose'); return; }
  const result = ACCOUNT_SYSTEM.resetPasswordByEmail(email, pass);
  if (!result.success) { showToast(result.error, 'rose'); return; }
  closeForgotPassword();
  showToast('Password updated! You can sign in now.', 'success');
  fireConfetti();
  showLoginModal();
}

function setAuthBtnLoading(btn, isLoading, loadingText) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.classList.add('is-loading');
    btn.innerHTML = '<span class="auth-btn-spinner" aria-hidden="true"></span><span>' + (loadingText || 'Loading...') + '</span>';
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-loading');
    if (btn.dataset.idleHtml) btn.innerHTML = btn.dataset.idleHtml;
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

async function handleLoginForm(e) {
  e.preventDefault();
  const btn = document.getElementById('login-submit-btn') || (e.target && e.target.querySelector('.submit-btn'));
  if (btn && btn.disabled) return;
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  setAuthBtnLoading(btn, true, 'Signing in...');
  try {
    await ACCOUNT_SYSTEM.ensureCloudSync(true);
    let result = ACCOUNT_SYSTEM.login(email, password);
    if (!result.success && /not found/i.test(result.error || '')) {
      await ACCOUNT_SYSTEM.importCloudUserByEmail(email);
      result = ACCOUNT_SYSTEM.login(email, password);
    }
    if (result.success) {
      closeLoginModal();
      const user = ACCOUNT_SYSTEM.getCurrentUser();
      showToast('Welcome back, ' + user.firstname + '!', 'success');
      fireConfetti();
      loadUserData(result.username);
      updateUserUI();
      navigateTo('dashboard');
      maybeStartTutorial(result.username);
      await ACCOUNT_SYSTEM.pushUserToCloud(result.username);
    } else if (/not found/i.test(result.error || '') && ACCOUNT_SYSTEM._lastCloudError) {
      showToast(ACCOUNT_SYSTEM._lastCloudError, 'rose');
    } else showToast(result.error, 'rose');
  } finally {
    setAuthBtnLoading(btn, false);
  }
}

async function handleRegisterForm(e) {
  e.preventDefault();
  const btn = document.getElementById('register-submit-btn') || (e.target && e.target.querySelector('.submit-btn'));
  if (btn && btn.disabled) return;
  const firstname = document.getElementById('register-firstname').value.trim();
  const lastname = document.getElementById('register-lastname').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-confirm-password').value;
  if (password !== confirm) { showToast('Passwords do not match!', 'rose'); return; }
  const strengthResult = ACCOUNT_SYSTEM.validatePassword(password);
  if (!strengthResult.valid) { showToast(strengthResult.message, 'rose'); return; }
  setAuthBtnLoading(btn, true, 'Creating account...');
  try {
    await ACCOUNT_SYSTEM.ensureCloudSync();
    const result = ACCOUNT_SYSTEM.register(firstname, lastname, email, password);
    if (result.success) {
      closeLoginModal();
      showToast('Account created! Welcome ' + firstname + '!', 'success');
      fireConfetti();
      const username = result.username || email.split('@')[0];
      const loginResult = ACCOUNT_SYSTEM.login(email, password);
      if (loginResult.success) {
        loadUserData(username);
        updateUserUI();
        navigateTo('dashboard');
        maybeStartTutorial(username);
      }
      await ACCOUNT_SYSTEM.pushUserToCloud(username);
    } else showToast(result.error, 'rose');
  } finally {
    setAuthBtnLoading(btn, false);
  }
}

function handleSocialLogin(provider) {
  showToast(provider.charAt(0).toUpperCase() + provider.slice(1) + ' login coming soon!', 'info');
}

function showConfirmModal(title, message, onConfirm) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-message').textContent = message;
  confirmModalCallback = onConfirm;
  document.getElementById('confirm-modal').style.display = 'flex';
  lockBodyScroll();
  lucide.createIcons();
}
function closeConfirmModal(confirmed) {
  document.getElementById('confirm-modal').style.display = 'none';
  unlockBodyScrollIfIdle();
  const cb = confirmModalCallback;
  confirmModalCallback = null;
  if (confirmed && cb) cb();
}

function handleLogout() {
  showConfirmModal('Sign Out', 'Are you sure you want to sign out?', function () {
    ACCOUNT_SYSTEM.logout();
    const authBtn = document.getElementById('auth-btn-nav');
    if (authBtn) authBtn.style.display = 'flex';
    const sidebarAuth = document.getElementById('sidebar-auth-section');
    const sidebarUser = document.getElementById('sidebar-user-section');
    if (sidebarAuth) sidebarAuth.style.display = 'block';
    if (sidebarUser) sidebarUser.style.display = 'none';
    const headName = document.getElementById('sidebar-head-name');
    const headAvatar = document.getElementById('sidebar-head-avatar');
    if (headName) headName.textContent = 'Guest';
    if (headAvatar) {
      headAvatar.style.backgroundImage = '';
      headAvatar.textContent = 'G';
    }
    Object.assign(state, {
      income: [], expenses: [], savings: [], investments: [], protection: [], goals: [],
      settings: ACCOUNT_SYSTEM.defaultSettings(), notificationsLog: [], readNotificationKeys: [], sampleMode: false
    });
    showToast('Signed out successfully', 'info');
    navigateTo('welcome');
  });
}

function updateUserUI() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  const authBtn = document.getElementById('auth-btn-nav');
  if (authBtn) authBtn.style.display = 'none';
  const sidebarAuth = document.getElementById('sidebar-auth-section');
  const sidebarUser = document.getElementById('sidebar-user-section');
  if (sidebarAuth) sidebarAuth.style.display = 'none';
  if (sidebarUser) sidebarUser.style.display = 'block';
  const fullName = (user.firstname + ' ' + user.lastname).trim();
  const initial = (user.firstname || 'U').charAt(0).toUpperCase();
  const headName = document.getElementById('sidebar-head-name');
  const headAvatar = document.getElementById('sidebar-head-avatar');
  if (headName) headName.textContent = fullName;
  if (headAvatar) {
    if (user.avatar) {
      headAvatar.textContent = '';
      headAvatar.style.backgroundImage = 'url(' + user.avatar + ')';
      headAvatar.style.backgroundSize = 'cover';
      headAvatar.style.backgroundPosition = 'center';
    } else {
      headAvatar.style.backgroundImage = '';
      headAvatar.textContent = initial;
    }
  }
  const se = document.getElementById('sidebar-user-email');
  if (se) se.textContent = user.email;
  const settingsName = document.getElementById('settings-name');
  const settingsEmail = document.getElementById('settings-email');
  const settingsPhone = document.getElementById('settings-phone');
  const settingsAvatar = document.getElementById('settings-avatar');
  if (settingsName) settingsName.textContent = fullName || '—';
  if (settingsEmail) settingsEmail.textContent = user.email || '—';
  if (settingsPhone) settingsPhone.textContent = user.phone ? user.phone : 'Add phone number';
  if (settingsAvatar) {
    if (user.avatar) {
      settingsAvatar.textContent = '';
      settingsAvatar.style.backgroundImage = 'url(' + user.avatar + ')';
      settingsAvatar.classList.add('has-photo');
    } else {
      settingsAvatar.style.backgroundImage = '';
      settingsAvatar.classList.remove('has-photo');
      settingsAvatar.textContent = initial;
    }
  }
  lucide.createIcons();
}

/* ---------- Data load / save ---------- */
function loadUserData(username) {
  let data = ensureMigratedData(ACCOUNT_SYSTEM.getUserData(username));
  state.income = data.income;
  state.expenses = data.expenses;
  state.savings = data.savings;
  state.investments = data.investments;
  state.protection = data.protection;
  state.goals = data.goals;
  state.settings = data.settings;
  state.notificationsLog = data.notificationsLog;
  state.readNotificationKeys = data.readNotificationKeys || [];
  state.sampleMode = false;
  if (data.settings && data.settings.theme) setTheme(data.settings.theme);
  else setTheme(getStoredTheme());
  syncSampleModeFlag();
  renderApp();
}

function saveUserData() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  ACCOUNT_SYSTEM.saveUserData(user.username, {
    income: state.income,
    expenses: state.expenses,
    savings: state.savings,
    investments: state.investments,
    protection: state.protection,
    goals: state.goals,
    settings: state.settings,
    notificationsLog: state.notificationsLog,
    readNotificationKeys: state.readNotificationKeys || []
  });
}

function sampleBackupKey(username) {
  return 'fintrack_pre_sample_' + username;
}

function sampleFlagKey(username) {
  return 'fintrack_sample_active_' + username;
}

function sampleBackupMetaKey(username) {
  return 'fintrack_pre_sample_meta_' + username;
}

function isFinanceDataEmpty(data) {
  if (!data) return true;
  return !(data.income && data.income.length)
    && !(data.expenses && data.expenses.length)
    && !(data.savings && data.savings.length)
    && !(data.investments && data.investments.length)
    && !(data.protection && data.protection.length)
    && !(data.goals && data.goals.length);
}

/** Detect the bundled demo pack (used to heal corrupted "original" backups). */
function looksLikeBundledSample(data) {
  if (!data || !Array.isArray(data.income) || !Array.isArray(data.expenses)) return false;
  const incomeDescs = data.income.map(function (x) { return String(x.desc || ''); });
  const expenseDescs = data.expenses.map(function (x) { return String(x.desc || ''); });
  return incomeDescs.indexOf('Monthly Salary') !== -1
    && incomeDescs.indexOf('Web Design Freelance') !== -1
    && expenseDescs.indexOf('Boarding House Rent') !== -1
    && expenseDescs.indexOf('Food & Groceries') !== -1;
}

function snapshotFinanceData() {
  return ensureMigratedData({
    income: state.income,
    expenses: state.expenses,
    savings: state.savings,
    investments: state.investments,
    protection: state.protection,
    goals: state.goals,
    settings: state.settings,
    notificationsLog: state.notificationsLog,
    readNotificationKeys: state.readNotificationKeys || []
  });
}

function applyFinanceData(data, keepTheme) {
  const next = ensureMigratedData(data || ACCOUNT_SYSTEM.emptyData());
  state.income = next.income;
  state.expenses = next.expenses;
  state.savings = next.savings;
  state.investments = next.investments;
  state.protection = next.protection;
  state.goals = next.goals;
  state.settings = Object.assign({}, next.settings || ACCOUNT_SYSTEM.defaultSettings(), keepTheme ? { theme: getStoredTheme() } : {});
  state.notificationsLog = next.notificationsLog || [];
  state.readNotificationKeys = next.readNotificationKeys || [];
}

function syncSampleModeFlag() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  state.sampleMode = localStorage.getItem(sampleFlagKey(user.username)) === '1';
  updateSampleButton();
}

function clearSampleFlagIfNeeded() {
  if (!state.sampleMode) return;
  state.sampleMode = false;
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (user) localStorage.removeItem(sampleFlagKey(user.username));
  updateSampleButton();
}

function toggleSampleData() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) { showToast('Please sign in first!', 'rose'); return; }
  const backupKey = sampleBackupKey(user.username);
  const flagKey = sampleFlagKey(user.username);
  const metaKey = sampleBackupMetaKey(user.username);
  const btn = document.getElementById('dash-toggle-sample-btn');
  const forceClear = btn && btn.dataset.forceClearSample === '1';

  if (state.sampleMode || forceClear) {
    showConfirmModal('Back to Original Data', 'Restore the data you had before loading sample? If your account was empty, everything goes back to ₱0.', function () {
      try {
        const raw = localStorage.getItem(backupKey);
        const metaRaw = localStorage.getItem(metaKey);
        let meta = null;
        try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch (e) { meta = null; }

        let restore = null;
        if (raw) {
          try { restore = ensureMigratedData(JSON.parse(raw)); } catch (e) { restore = null; }
        }

        // Heal bad backups: sample pack was wrongly saved as "original"
        const wasEmpty = meta && meta.wasEmpty === true;
        const shouldEmpty = forceClear
          || !restore
          || wasEmpty
          || isFinanceDataEmpty(restore)
          || (looksLikeBundledSample(restore) && (wasEmpty || meta == null));

        if (shouldEmpty) {
          applyFinanceData(ACCOUNT_SYSTEM.emptyData(), true);
        } else {
          applyFinanceData(restore, true);
        }
      } catch (err) {
        showToast('Could not restore previous data', 'rose');
        return;
      }
      state.sampleMode = false;
      if (btn) btn.dataset.forceClearSample = '';
      localStorage.removeItem(flagKey);
      localStorage.removeItem(backupKey);
      localStorage.removeItem(metaKey);
      saveUserData();
      renderApp();
      showToast(isFinanceDataEmpty(snapshotFinanceData()) ? 'Back to empty account (₱0)' : 'Restored your previous data', 'success');
      updateSampleButton();
    });
  } else {
    showConfirmModal('Load Sample Data', 'Replace your current figures with sample data? It will stay after refresh until you change or restore it.', function () {
      const existingBackup = localStorage.getItem(backupKey);
      if (!existingBackup) {
        const snap = snapshotFinanceData();
        localStorage.setItem(backupKey, JSON.stringify(snap));
        localStorage.setItem(metaKey, JSON.stringify({
          wasEmpty: isFinanceDataEmpty(snap),
          savedAt: new Date().toISOString()
        }));
      } else {
        // Heal older buggy backups that accidentally stored the sample pack as "original"
        try {
          const parsed = ensureMigratedData(JSON.parse(existingBackup));
          let meta = null;
          try { meta = JSON.parse(localStorage.getItem(metaKey) || 'null'); } catch (e) { meta = null; }
          const knownReal = meta && meta.wasEmpty === false;
          if (!knownReal && looksLikeBundledSample(parsed)) {
            localStorage.setItem(backupKey, JSON.stringify(ACCOUNT_SYSTEM.emptyData()));
            localStorage.setItem(metaKey, JSON.stringify({
              wasEmpty: true,
              savedAt: new Date().toISOString(),
              healed: true
            }));
          }
        } catch (e) { /* keep existing backup */ }
      }

      const sample = ensureMigratedData(ACCOUNT_SYSTEM.getSampleData());
      applyFinanceData(sample, true);
      state.sampleMode = true;
      localStorage.setItem(flagKey, '1');
      saveUserData();
      renderApp();
      showToast('Sample data loaded and saved', 'success');
      fireConfetti();
      updateSampleButton();
    });
  }
}

function updateSampleButton() {
  const btn = document.getElementById('dash-toggle-sample-btn');
  if (!btn) return;
  if (state.sampleMode) {
    btn.textContent = 'Back to Original Data';
    btn.dataset.forceClearSample = '';
    return;
  }
  // Demo pack still on screen after a bad restore/exit — let user zero out
  if (looksLikeBundledSample(snapshotFinanceData())) {
    btn.textContent = 'Back to Original Data';
    btn.dataset.forceClearSample = '1';
    return;
  }
  btn.textContent = 'Load Sample Data';
  btn.dataset.forceClearSample = '';
}

/* ---------- Navigation ---------- */
function isDesktopSidebar() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

function closeSidebarMobile() {
  if (isDesktopSidebar()) return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar || !sidebar.classList.contains('active')) return;
  sidebar.classList.remove('active');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  document.body.classList.remove('sidebar-open');
}

function navTo(view) {
  navigateTo(view);
  closeSidebarMobile();
}

function syncDesktopSidebar() {
  if (!isDesktopSidebar()) {
    document.body.classList.remove('sidebar-expanded');
    return;
  }
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('active');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('sidebar-open');
  document.body.style.overflow = '';
  // Never leave a stuck expanded class — CSS :hover handles expand/collapse.
  document.body.classList.remove('sidebar-expanded');
}

function initSidebarHoverExpand() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || sidebar.dataset.hoverBound === '1') return;
  sidebar.dataset.hoverBound = '1';
  // CSS :hover is the source of truth. Clear any stuck class on leave / outside click.
  sidebar.addEventListener('mouseleave', function () {
    document.body.classList.remove('sidebar-expanded');
  });
  document.addEventListener('click', function (e) {
    if (!sidebar.contains(e.target)) {
      document.body.classList.remove('sidebar-expanded');
    }
  });
}

function toggleSidebar(e) {
  if (e) e.stopPropagation();
  if (document.body.classList.contains('on-landing')) return;
  if (isDesktopSidebar() && !document.body.classList.contains('on-landing')) return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar || !overlay) return;
  sidebar.classList.toggle('active');
  overlay.classList.toggle('hidden');
  if (sidebar.classList.contains('active')) {
    document.body.style.overflow = 'hidden';
    document.body.classList.add('sidebar-open');
  } else {
    document.body.style.overflow = '';
    document.body.classList.remove('sidebar-open');
  }
  setTimeout(function () { if (typeof lucide !== 'undefined') lucide.createIcons(); }, 50);
}

function navigateTo(view) {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (view === 'notifications') {
    if (!user) { showLoginModal(); return; }
    openNotificationsDropdown();
    return;
  }
  if (view !== 'welcome' && !user) {
    showLoginModal();
    return;
  }
  if (view === 'goals') view = 'savings';
  if (!VIEWS.includes(view)) view = user ? 'dashboard' : 'welcome';
  if (view === 'welcome' && user) view = 'dashboard';
  state.currentView = view;
  VIEWS.forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  });
  const appViews = document.getElementById('app-views');
  if (appViews) appViews.classList.toggle('hidden', view === 'welcome');
  document.body.classList.toggle('on-landing', view === 'welcome');
  syncDesktopSidebar();
  document.querySelectorAll('.nav-side-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-nav') === view);
  });
  renderApp();
  if (view === 'analytics' || view === 'dashboard' || view === 'income' || view === 'spending' || view === 'savings' || view === 'investment' || view === 'protection') {
    setTimeout(updateCharts, 30);
  }
  setTimeout(function () {
    if (window.lucide) lucide.createIcons();
    if (view === 'welcome') initLandingScrollReveal();
  }, 40);
}

/* ---------- Tutorial ---------- */
function clearTutorialHighlights() {
  document.querySelectorAll('.tutorial-target').forEach(function (el) {
    el.classList.remove('tutorial-target');
  });
  document.querySelectorAll('.tutorial-nav-pulse').forEach(function (el) {
    el.classList.remove('tutorial-nav-pulse');
  });
}

function maybeStartTutorial(username) {
  const key = 'fintrack_tutorial_seen_' + username;
  if (localStorage.getItem(key)) return;
  state.tutorialStep = 0;
  state.tutorialActive = true;
  document.getElementById('tutorial-overlay').classList.remove('hidden');
  showTutorialStep();
}

function showTutorialStep() {
  const step = TUTORIAL_STEPS[state.tutorialStep];
  if (!step) return;

  document.getElementById('tutorial-step-label').textContent = 'Step ' + (state.tutorialStep + 1) + '/' + TUTORIAL_STEPS.length;
  document.getElementById('tutorial-title').textContent = step.title;
  document.getElementById('tutorial-body').textContent = step.body;
  document.getElementById('tutorial-prev').style.visibility = state.tutorialStep === 0 ? 'hidden' : 'visible';
  document.getElementById('tutorial-next').textContent = state.tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next';

  const goView = document.getElementById('tutorial-go-view');
  if (goView) {
    goView.textContent = 'Open ' + step.title + ' page';
    goView.classList.toggle('hidden', !step.view);
  }

  // Navigate to the real page for this step
  if (step.view) {
    state.tutorialActive = true;
    navigateTo(step.view);
  }

  clearTutorialHighlights();
  setTimeout(function () {
    const target = document.getElementById('view-' + step.view);
    if (target) {
      target.classList.add('tutorial-target');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.querySelectorAll('.nav-side-btn').forEach(function (btn) {
      if (btn.getAttribute('data-nav') === step.view) btn.classList.add('tutorial-nav-pulse');
    });
    if (window.lucide) lucide.createIcons();
  }, 80);
}

function nextTutorial() {
  if (state.tutorialStep >= TUTORIAL_STEPS.length - 1) { finishTutorial(); return; }
  state.tutorialStep++;
  showTutorialStep();
}
function prevTutorial() {
  if (state.tutorialStep > 0) { state.tutorialStep--; showTutorialStep(); }
}
function skipTutorial() { finishTutorial(); }
function finishTutorial() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (user) localStorage.setItem('fintrack_tutorial_seen_' + user.username, '1');
  state.tutorialActive = false;
  clearTutorialHighlights();
  document.getElementById('tutorial-overlay').classList.add('hidden');
  navigateTo('dashboard');
}

/* ---------- Achievements ---------- */
function getUnlockedIds() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return [];
  try { return JSON.parse(localStorage.getItem('fintrack_achievements_' + user.username)) || []; }
  catch { return []; }
}
function saveUnlockedIds(ids) {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  localStorage.setItem('fintrack_achievements_' + user.username, JSON.stringify(ids));
}
function checkAchievements() {
  if (!ACCOUNT_SYSTEM.getCurrentUser()) return;
  if (state.settings.notifications && state.settings.notifications.achievements === false) return;
  const unlocked = getUnlockedIds();
  ACHIEVEMENTS.forEach(a => {
    if (unlocked.includes(a.id)) return;
    if (a.test(state)) {
      unlocked.push(a.id);
      achievementQueue.push(a);
    }
  });
  saveUnlockedIds(unlocked);
  drainAchievementQueue();
}
function drainAchievementQueue() {
  if (achievementShowing || !achievementQueue.length) return;
  achievementShowing = true;
  const a = achievementQueue.shift();
  const popup = document.getElementById('achievement-popup');
  document.getElementById('achievement-emoji').textContent = a.emoji;
  document.getElementById('achievement-title').textContent = a.title;
  document.getElementById('achievement-desc').textContent = a.desc;
  popup.classList.remove('hidden');
  fireConfetti();
  setTimeout(() => {
    popup.classList.add('hidden');
    achievementShowing = false;
    drainAchievementQueue();
  }, 3200);
}

/* ---------- CRUD ---------- */
function handleModuleSubmit(e, module) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  clearSampleFlagIfNeeded();
  const id = Date.now();
  if (module === 'income') {
    // Income uses modal submitIncomeModal()
    return;
  } else if (module === 'spending') {
    // Spending uses modal submitExpenseModal()
    return;
  } else if (module === 'savings') {
    // Savings uses modal submitSavingsModal()
    return;
  } else if (module === 'investment') {
    // Investment uses modal submitInvestmentModal()
    return;
  } else if (module === 'protection') {
    // Protection uses modal submitProtectionModal()
    return;
  }
  showToast('Saved to ' + module + '!', 'success');
  fireConfetti();
  saveUserData();
  renderApp();
  checkAchievements();
}

function deleteItem(tab, id) {
  if (tab === 'expenses') state.expenses = state.expenses.filter(i => i.id !== id);
  else if (tab === 'investments') state.investments = state.investments.filter(i => i.id !== id);
  else state[tab] = state[tab].filter(i => i.id !== id);
  clearSampleFlagIfNeeded();
  showToast('Item removed', 'rose');
  saveUserData();
  renderApp();
}

function toggleSavingsProgress(id) {
  completeSavingsGoal(id);
}

/* ---------- Settings ---------- */
function saveSettingsFromUI() {
  state.settings.budgetLimit = parseFloat(document.getElementById('set-budget').value) || 0;
  const alertEl = document.getElementById('set-expense-alert');
  if (alertEl) {
    const t = parseFloat(alertEl.value);
    state.settings.expenseAlertThreshold = Number.isFinite(t) && t >= 0 ? t : 2000;
  }
  state.settings.currency = document.getElementById('set-currency').value || 'PHP';
  state.settings.notifications = {
    budget: document.getElementById('set-notif-budget').checked,
    goals: document.getElementById('set-notif-goals').checked,
    achievements: document.getElementById('set-notif-achievements').checked
  };
  clearSampleFlagIfNeeded();
  saveUserData();
  showToast('Settings saved', 'success');
  renderApp();
}

function changePasswordFromSettings() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  const cur = document.getElementById('set-current-pass').value;
  const neu = document.getElementById('set-new-pass').value;
  const result = ACCOUNT_SYSTEM.changePassword(user.username, cur, neu);
  if (!result.success) { showToast(result.error, 'rose'); return; }
  document.getElementById('set-current-pass').value = '';
  document.getElementById('set-new-pass').value = '';
  showToast('Password changed!', 'success');
  fireConfetti();
}

function openProfileEditModal() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) { showToast('Please sign in first!', 'rose'); return; }
  const fn = document.getElementById('profile-edit-firstname');
  const ln = document.getElementById('profile-edit-lastname');
  const em = document.getElementById('profile-edit-email');
  const ph = document.getElementById('profile-edit-phone');
  if (fn) fn.value = user.firstname || '';
  if (ln) ln.value = user.lastname || '';
  if (em) em.value = user.email || '';
  if (ph) ph.value = user.phone || '';
  const modal = document.getElementById('profile-edit-modal');
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeProfileEditModal() {
  const modal = document.getElementById('profile-edit-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function saveProfileFromModal() {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) return;
  const result = ACCOUNT_SYSTEM.updateProfile(user.username, {
    firstname: (document.getElementById('profile-edit-firstname') || {}).value || '',
    lastname: (document.getElementById('profile-edit-lastname') || {}).value || '',
    email: (document.getElementById('profile-edit-email') || {}).value || '',
    phone: (document.getElementById('profile-edit-phone') || {}).value || ''
  });
  if (!result.success) { showToast(result.error, 'rose'); return; }
  closeProfileEditModal();
  updateUserUI();
  showToast('Profile updated', 'success');
}

function handleSettingsAvatarChange(event) {
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  if (!user) { showToast('Please sign in first!', 'rose'); return; }
  const file = event && event.target && event.target.files && event.target.files[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) { showToast('Please choose an image file.', 'rose'); return; }
  if (file.size > 1.5 * 1024 * 1024) { showToast('Image must be under 1.5 MB.', 'rose'); return; }
  const reader = new FileReader();
  reader.onload = function () {
    const dataUrl = String(reader.result || '');
    const result = ACCOUNT_SYSTEM.updateProfile(user.username, { avatar: dataUrl });
    if (!result.success) { showToast(result.error, 'rose'); return; }
    updateUserUI();
    showToast('Profile photo updated', 'success');
  };
  reader.onerror = function () { showToast('Could not read that image.', 'rose'); };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function populateSettingsUI() {
  const s = state.settings;
  const budget = document.getElementById('set-budget');
  if (budget) budget.value = s.budgetLimit || 0;
  const expenseAlert = document.getElementById('set-expense-alert');
  if (expenseAlert) {
    expenseAlert.value = s.expenseAlertThreshold != null ? s.expenseAlertThreshold : 2000;
  }
  const cur = document.getElementById('set-currency');
  if (cur) cur.value = s.currency || 'PHP';
  const nb = document.getElementById('set-notif-budget');
  const ng = document.getElementById('set-notif-goals');
  const na = document.getElementById('set-notif-achievements');
  if (nb) nb.checked = !!(s.notifications && s.notifications.budget);
  if (ng) ng.checked = !!(s.notifications && s.notifications.goals);
  if (na) na.checked = s.notifications ? s.notifications.achievements !== false : true;
  renderThemePresets();
  const seasonSelect = document.getElementById('seasonal-accent-select');
  if (seasonSelect) seasonSelect.value = getSeasonalMode();
  updateUserUI();
}

/* ---------- Mini calendar ---------- */
function shiftMiniCalendar(dir) {
  state.calMonth += dir;
  if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
  if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
  renderMiniCalendar();
}

function scheduleDatesSet() {
  const set = new Set();
  (state.savings || []).forEach(function (g) { if (g.dueDate && !g.isCompleted) set.add(g.dueDate); });
  state.expenses.forEach(e => {
    if (e.date && (e.needWant === 'Need' || isBillCategory(e.category))) set.add(e.date);
  });
  return set;
}

function renderMiniCalendar() {
  const wrap = document.getElementById('mini-calendar');
  const title = document.getElementById('mini-cal-title');
  if (!wrap) return;
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (title) title.textContent = monthNames[state.calMonth] + ' ' + state.calYear;
  const first = new Date(state.calYear, state.calMonth, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(state.calYear, state.calMonth + 1, 0).getDate();
  const events = scheduleDatesSet();
  const today = new Date();
  let html = '';
  for (let i = 0; i < startPad; i++) html += '<div class="mini-cal-day muted"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = state.calYear + '-' + String(state.calMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const isToday = today.getFullYear() === state.calYear && today.getMonth() === state.calMonth && today.getDate() === d;
    const vSeason = document.body.classList.contains('season-valentines');
    const xSeason = document.body.classList.contains('season-christmas');
    const eSeason = document.body.classList.contains('season-easter');
    const hSeason = document.body.classList.contains('season-halloween');
    const isFeb14 = vSeason && state.calMonth === 1 && d === 14;
    const isXmasEve = xSeason && state.calMonth === 11 && d === 24;
    const isXmasDay = xSeason && state.calMonth === 11 && d === 25;
    const easterDate = eSeason ? getEasterSunday(state.calYear) : null;
    const isEasterDay = eSeason && easterDate && state.calMonth === easterDate.month && d === easterDate.day;
    const isHalloDay = hSeason && state.calMonth === 9 && d === 31;
    // Valentine: today = heart; Christmas: Dec 24/25 = tree; Easter Sunday = egg; Oct 31 = pumpkin
    const isHeartDay = vSeason && (isToday || isFeb14);
    const dow = (startPad + d - 1) % 7;
    const isSun = dow === 0;
    const cls = [
      'mini-cal-day',
      events.has(iso) ? 'has-event' : '',
      isToday && !isHeartDay ? 'today' : '',
      isToday && isHeartDay ? 'today is-vday' : '',
      !isToday && isHeartDay ? 'is-vday' : '',
      isXmasEve || isXmasDay ? 'is-xmas' : '',
      isEasterDay ? 'is-easter' : '',
      isHalloDay ? 'is-halloween' : '',
      isSun ? 'is-sun' : ''
    ].filter(Boolean).join(' ');
    let title = isToday ? 'Today' : isFeb14 ? "Valentine's Day" : isXmasDay ? 'Christmas Day' : isXmasEve ? 'Christmas Eve' : isEasterDay ? 'Easter Sunday' : isHalloDay ? 'Halloween' : events.has(iso) ? 'Scheduled' : '';
    if (isHeartDay) {
      html += '<div class="' + cls + '" title="' + title + '">'
        + '<span class="vday-cal-heart" aria-hidden="true">♥</span>'
        + '<span class="vday-cal-num">' + d + '</span></div>';
    } else if (isXmasEve || isXmasDay) {
      html += '<div class="' + cls + '" title="' + title + '">'
        + '<span class="xmas-cal-mark" aria-hidden="true"></span>'
        + '<span class="xmas-cal-num">' + d + '</span></div>';
    } else if (isEasterDay) {
      html += '<div class="' + cls + '" title="' + title + '">'
        + '<span class="easter-cal-mark" aria-hidden="true"></span>'
        + '<span class="easter-cal-num">' + d + '</span></div>';
    } else if (isHalloDay) {
      html += '<div class="' + cls + '" title="' + title + '">'
        + '<span class="halloween-cal-mark" aria-hidden="true"></span>'
        + '<span class="halloween-cal-num">' + d + '</span></div>';
    } else {
      html += '<div class="' + cls + '" title="' + title + '">' + d + '</div>';
    }
  }
  wrap.innerHTML = html;
}

/* ---------- Render modules ---------- */
function renderApp() {
  updateSummaryMetrics();
  updateSidebarStats();
  renderMiniCalendar();
  renderDashboardExtras();
  renderModuleTables();
  renderProtectionPanel();
  renderAnalyticsPage();
  renderCalculator();
  renderNotificationsCenter();
  populateSettingsUI();
  updateSampleButton();
  updateCharts();
  lucide.createIcons();
}

function sumInCalendarMonth(arr, year, month) {
  return (arr || []).reduce(function (a, item) {
    if (!item || !item.date) return a;
    const d = new Date(item.date);
    if (Number.isNaN(d.getTime())) return a;
    if (d.getFullYear() === year && d.getMonth() === month) return a + Number(item.amount || 0);
    return a;
  }, 0);
}

function monthOverMonthPct(arr) {
  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth();
  const prev = new Date(cy, cm - 1, 1);
  const currTotal = sumInCalendarMonth(arr, cy, cm);
  const prevTotal = sumInCalendarMonth(arr, prev.getFullYear(), prev.getMonth());
  if (prevTotal === 0 && currTotal === 0) return 0;
  if (prevTotal === 0) return currTotal > 0 ? 100 : 0;
  return Math.round(((currTotal - prevTotal) / prevTotal) * 100);
}

function formatMomTrend(pct) {
  const abs = Math.abs(pct);
  if (pct === 0) return { text: '— 0% vs. last month', tone: '' };
  if (pct > 0) return { text: '▲ ' + abs + '% vs. last month', tone: 'is-up' };
  return { text: '▼ ' + abs + '% vs. last month', tone: 'is-down' };
}

function setMetricTrend(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const info = formatMomTrend(pct);
  el.textContent = info.text;
  el.classList.remove('is-up', 'is-down');
  if (info.tone) el.classList.add(info.tone);
}

function updateSummaryMetrics() {
  const t = totals();
  const hs = healthScore();
  animateNumber(document.getElementById('stat-income'), t.income);
  animateNumber(document.getElementById('stat-spending'), t.spending);
  animateNumber(document.getElementById('stat-savings'), t.savings);
  animateNumber(document.getElementById('stat-investments'), t.investments);
  const protEl = document.getElementById('stat-protection');
  const types = new Set(state.protection.map(p => normalizeProtType(p.policyType)));
  if (protEl) {
    protEl.textContent = types.size ? types.size + '/9 types' : 'None';
  }
  const protTrend = document.getElementById('stat-protection-trend');
  if (protTrend) {
    protTrend.textContent = types.size ? types.size + ' active coverage type' + (types.size === 1 ? '' : 's') : 'No active coverage';
    protTrend.classList.remove('is-up', 'is-down');
  }
  setMetricTrend('stat-income-trend', monthOverMonthPct(state.income));
  setMetricTrend('stat-spending-trend', monthOverMonthPct(state.expenses));
  setMetricTrend('stat-savings-trend', monthOverMonthPct(state.savings));
  setMetricTrend('stat-investments-trend', monthOverMonthPct(state.investments));
  animateNumber(document.getElementById('income-remaining'), t.remaining);
  const ring = document.getElementById('health-score-ring');
  if (ring) ring.style.setProperty('--score', hs);
  const hsv = document.getElementById('health-score-value');
  if (hsv) hsv.textContent = hs;
  const hsl = document.getElementById('health-score-label');
  if (hsl) {
    if (!hasFinancialData()) {
      hsl.textContent = 'Add data to unlock pillar scores';
    } else {
      const p = pillarScores();
      hsl.textContent = 'I ' + p.income + ' · S ' + p.savings + ' · Sp ' + p.spending + ' · Inv ' + p.investment + ' · P ' + p.protection;
    }
  }
  const band = healthBandLabel(hs);
  const user = ACCOUNT_SYSTEM.getCurrentUser();
  const name = formatFirstName(user);
  const isVday = document.body.classList.contains('season-valentines');
  const isXmas = document.body.classList.contains('season-christmas');
  const isEaster = document.body.classList.contains('season-easter');
  const isHalloween = document.body.classList.contains('season-halloween');
  const timeLabel = document.getElementById('dash-time-label');
  if (timeLabel) timeLabel.textContent = timeOfDayLabel();
  const greet = document.getElementById('dash-greeting');
  if (greet) {
    if (isVday) {
      greet.innerHTML = timeOfDayLabel() + ', <span class="dash-hello-name">' + name + '</span>! <span class="vday-heart" aria-hidden="true">❤️</span>';
    } else if (isXmas) {
      greet.innerHTML = timeOfDayLabel() + ', <span class="dash-hello-name">' + name + '</span>!';
    } else if (isEaster) {
      greet.innerHTML = 'Hey, <span class="dash-hello-name">' + name + '</span>!';
    } else if (isHalloween) {
      greet.innerHTML = 'Hey, <span class="dash-hello-name">' + name + '</span>!';
    } else {
      greet.innerHTML = 'Hey, <span class="dash-hello-name">' + name + '</span>!';
    }
  }
  const sub = document.getElementById('dash-greeting-sub');
  if (sub) {
    if (isVday) sub.textContent = 'Small steps today, big dreams tomorrow.';
    else if (isXmas) sub.textContent = 'May your financial goals bring you more joy this Christmas season!';
    else if (isEaster) sub.textContent = 'May this Easter bring you renewed strength, peace, and more financial blessings!';
    else if (isHalloween) sub.textContent = 'Even the smallest steps towards your goals are progress. Keep going!';
    else sub.textContent = progressEncouragement(hs);
  }
  const healthBandEl = document.getElementById('dash-health-band');
  if (healthBandEl) healthBandEl.textContent = band;
  const heroFocus = document.getElementById('dash-hero-focus');
  if (heroFocus) {
    const focus = pillarFocusCopy();
    heroFocus.textContent = focus || 'You got this!';
  }
  renderFinancialHealthPanel();
  lucide.createIcons();
  const budgetLabel = document.getElementById('spending-budget-label');
  if (budgetLabel) budgetLabel.textContent = peso(state.settings.budgetLimit || 0);

  animateNumber(document.getElementById('sav-total'), t.savings);
  animateNumber(document.getElementById('sav-ef'), t.ef);
  const monthlySav = state.savings.reduce((a, s) => a + Number(s.monthly || 0), 0);
  animateNumber(document.getElementById('sav-monthly'), monthlySav);
  const eta = document.getElementById('sav-eta');
  if (eta) {
    const incomplete = (state.savings || []).filter(function (g) {
      return !g.isCompleted && Number(g.target) > 0 && Number(g.amount) < Number(g.target);
    });
    if (!incomplete.length) eta.textContent = 'Goals clear';
    else {
      const g = incomplete[0];
      const left = Number(g.target) - Number(g.amount);
      const m = Number(g.monthly || monthlySav || 0);
      eta.textContent = m > 0 ? '~' + Math.ceil(left / m) + ' mo (' + g.desc + ')' : 'Set monthly ₱';
    }
  }
}

function updateSidebarStats() {
  const bal = document.getElementById('sidebar-total-balance');
  if (bal) {
    const t = totals();
    animateNumber(bal, t.remaining);
  }
  const g = document.getElementById('sidebar-goals-count');
  if (g) g.textContent = String((state.savings || []).filter(function (s) { return !s.isCompleted; }).length);
  const sr = document.getElementById('sidebar-savings-rate');
  if (sr) sr.textContent = totals().savingsRate.toFixed(1) + '%';
  const sh = document.getElementById('sidebar-health-score');
  if (sh) sh.textContent = healthScore() + '/100';
  const act = document.getElementById('sidebar-latest-activity');
  if (act) {
    const latest = [].concat(state.income, state.expenses).sort((a, b) => b.id - a.id)[0];
    act.textContent = latest ? ('Latest: ' + latest.desc) : 'Welcome to FinWise';
  }
  updateNotificationBadge();
}

function notificationKey(n) {
  return String(n.id || (n.level + '|' + n.text));
}

function getActionableNotifications() {
  return buildNotifications().filter(function (n) { return n.level !== 'ok'; });
}

function getUnreadNotifications() {
  const read = new Set(state.readNotificationKeys || []);
  return getActionableNotifications().filter(function (n) {
    return !read.has(notificationKey(n));
  });
}

function markNotificationReadByKey(key) {
  if (!key) return;
  const set = new Set(state.readNotificationKeys || []);
  if (set.has(key)) return;
  set.add(key);
  state.readNotificationKeys = Array.from(set);
  saveUserData();
  updateNotificationBadge();
}

function handleNotificationClick(event, key, action) {
  if (event) event.stopPropagation();
  markNotificationReadByKey(key);
  closeNotificationsDropdown();
  if (action === 'calendar') {
    navigateTo('dashboard');
    setTimeout(function () {
      const cal = document.querySelector('.dash-cal-card') || document.getElementById('mini-calendar');
      if (cal) cal.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    return;
  }
  if (action === 'spending' || action === 'savings' || action === 'settings' || action === 'dashboard') {
    navigateTo(action);
    return;
  }
  navigateTo('dashboard');
}

function markAllNotificationsRead(event) {
  if (event) event.stopPropagation();
  const keys = getActionableNotifications().map(notificationKey);
  const set = new Set(state.readNotificationKeys || []);
  keys.forEach(function (k) { set.add(k); });
  state.readNotificationKeys = Array.from(set);
  saveUserData();
  updateNotificationBadge();
  renderNotificationsCenter();
  showToast('All notifications marked as read', 'info');
}

function renderNotificationsCenter() {
  const wrap = document.getElementById('notifications-list');
  if (!wrap) return;
  const notes = buildNotifications();
  const read = new Set(state.readNotificationKeys || []);
  if (!notes.length) {
    wrap.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
    return;
  }
  wrap.innerHTML = notes.map(function (n) {
    const key = notificationKey(n);
    const isRead = n.level === 'ok' || read.has(key);
    const tone = n.level === 'warn' ? 'is-warn' : (n.level === 'ok' ? 'is-ok' : 'is-info');
    const action = n.action || 'dashboard';
    const safeKey = String(key).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<button type="button" class="notif-item ' + tone + (isRead ? ' is-read' : ' is-unread') + '" role="menuitem"'
      + ' data-key="' + escapeHtml(key) + '" data-action="' + escapeHtml(action) + '"'
      + ' onclick="handleNotificationClick(event, \'' + safeKey + '\', \'' + action + '\')">'
      + '<div class="notif-item-icon"><i data-lucide="bell"></i></div>'
      + '<p class="notif-item-text">' + escapeHtml(n.text) + '</p>'
      + '<i data-lucide="chevron-right" class="notif-item-chevron"></i>'
      + '</button>';
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateNotificationBadge() {
  const count = getUnreadNotifications().length;
  const dot = document.getElementById('notif-dot');
  const badge = document.getElementById('notif-count');
  if (dot) dot.classList.add('hidden');
  if (badge) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }
}

function closeNotificationsDropdown() {
  const panel = document.getElementById('notif-dropdown');
  const btn = document.getElementById('header-notif-btn');
  if (panel) {
    panel.classList.remove('active');
    panel.hidden = true;
  }
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openNotificationsDropdown() {
  const panel = document.getElementById('notif-dropdown');
  const btn = document.getElementById('header-notif-btn');
  renderNotificationsCenter();
  if (panel) {
    panel.hidden = false;
    panel.classList.add('active');
  }
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function toggleNotificationsDropdown(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const panel = document.getElementById('notif-dropdown');
  if (!panel) return;
  if (panel.classList.contains('active')) closeNotificationsDropdown();
  else openNotificationsDropdown();
}

function renderDashboardExtras() {
  const goalsList = document.getElementById('dash-goals-list');
  if (goalsList) {
    const top = (state.savings || []).filter(function (s) { return !s.isCompleted; })
      .slice()
      .sort(function (a, b) {
        const pa = Number(a.target) > 0 ? Number(a.amount) / Number(a.target) : 0;
        const pb = Number(b.target) > 0 ? Number(b.amount) / Number(b.target) : 0;
        return pb - pa;
      })
      .slice(0, 4);
    if (!top.length) {
      goalsList.innerHTML =
        '<div class="dash-goals-empty">'
        + '<div class="dash-goals-empty-art" aria-hidden="true"><i data-lucide="target"></i></div>'
        + '<div class="dash-goals-empty-copy">'
        + '<p class="dash-goals-empty-title">No savings goals yet.</p>'
        + '<p class="dash-goals-empty-sub">Set your first goal in Savings and start building your future!</p>'
        + '<button type="button" class="dash-goals-add-btn" onclick="navigateTo(\'savings\')">'
        + '<i data-lucide="plus"></i> Add Goal</button>'
        + '</div></div>';
    } else {
      goalsList.innerHTML = top.map(function (g) {
        const targetAmt = Number(g.target) > 0 ? Number(g.target) : Number(g.amount) || 0;
        const pct = targetAmt > 0 ? Math.min(100, Math.round((Number(g.amount) / targetAmt) * 100)) : 0;
        return '<div class="dash-goal-row">'
          + '<div class="flex justify-between text-xs mb-1"><span class="font-bold">' + escapeHtml(g.desc) + '</span><span>' + pct + '%</span></div>'
          + '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>'
          + '</div>';
      }).join('');
    }
  }
  const notif = document.getElementById('dash-notifications');
  if (notif) notif.innerHTML = buildNotifications().slice(0, 5).map(n => '<li>• ' + escapeHtml(n.text) + '</li>').join('');
  const insights = document.getElementById('dash-insights');
  if (insights) insights.innerHTML = buildInsights().map(i => '<li>• ' + escapeHtml(i) + '</li>').join('');
  const nba = document.getElementById('dash-next-action');
  if (nba) nba.textContent = nextBestAction();
  const pers = moneyPersonality();
  const pt = document.getElementById('dash-personality-title');
  const pd = document.getElementById('dash-personality-desc');
  if (pt) pt.textContent = pers.title;
  if (pd) pd.textContent = pers.desc;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const INCOME_TYPE_ORDER = [
  'Active Income',
  'Side Hustle',
  'Business',
  'Passive Income',
  'Investment Income',
  'Allowance',
  'Gifts',
  'Rental Income',
  'Online Income',
  'Commission & Tips',
  'Government Benefits',
  'Other Income'
];

const INCOME_TYPE_COLORS = {
  'Active Income': '#B46A72',
  'Side Hustle': '#A8B58A',
  'Business': '#6f8458',
  'Passive Income': '#A9B7C6',
  'Investment Income': '#D4A574',
  'Allowance': '#7f9bb8',
  'Gifts': '#c48a9a',
  'Rental Income': '#8a9a78',
  'Online Income': '#9b8ec4',
  'Commission & Tips': '#e8a05c',
  'Government Benefits': '#6b7599',
  'Other Income': '#9aa3ad'
};

const INCOME_TYPE_ICONS = {
  'Active Income': 'briefcase',
  'Side Hustle': 'laptop',
  'Business': 'store',
  'Passive Income': 'play',
  'Investment Income': 'line-chart',
  'Allowance': 'wallet',
  'Gifts': 'gift',
  'Rental Income': 'home',
  'Online Income': 'globe',
  'Commission & Tips': 'coins',
  'Government Benefits': 'landmark',
  'Other Income': 'circle-dot'
};

function incomeTypeClass(type) {
  const t = normalizeIncomeType(type);
  const map = {
    'Active Income': 'is-active',
    'Side Hustle': 'is-side',
    'Business': 'is-business',
    'Passive Income': 'is-passive',
    'Investment Income': 'is-invest',
    'Allowance': 'is-allowance',
    'Gifts': 'is-gift',
    'Rental Income': 'is-rental',
    'Online Income': 'is-online',
    'Commission & Tips': 'is-commission',
    'Government Benefits': 'is-gov',
    'Other Income': 'is-other'
  };
  return map[t] || 'is-other';
}

function incomeSourceIcon(item) {
  const t = normalizeIncomeType(item.type);
  if (INCOME_TYPE_ICONS[t]) return INCOME_TYPE_ICONS[t];
  const d = String(item.desc || '').toLowerCase();
  if (/youtube|ad|stream|passive/.test(d)) return 'play';
  if (/freelance|web|design|laptop|side/.test(d)) return 'laptop';
  if (/salary|job|wage|payroll/.test(d)) return 'briefcase';
  return 'wallet';
}

function filterIncomeRows() {
  const q = ((document.getElementById('income-search') || {}).value || '').trim().toLowerCase();
  return state.income.filter(function (i) {
    if (!q) return true;
    const hay = ((i.desc || '') + ' ' + (i.type || '') + ' ' + (i.date || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
  }).slice().sort(function (a, b) {
    return String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id);
  });
}

function incomeInChartRange(list, rangeVal) {
  if (rangeVal !== 'month') return list;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  return list.filter(function (i) {
    if (!i.date) return true;
    const d = new Date(i.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });
}

function onIncomeFilterChange() {
  state.incomePage = 1;
  renderIncomePage();
}

function shiftIncomePage(dir) {
  const rows = filterIncomeRows();
  const pages = Math.max(1, Math.ceil(rows.length / (state.incomePageSize || 5)));
  state.incomePage = Math.min(pages, Math.max(1, (state.incomePage || 1) + dir));
  renderIncomePage();
}

var pendingIncomeDeleteId = null;

function openIncomeModal(editId) {
  const modal = document.getElementById('income-modal');
  const title = document.getElementById('income-modal-title');
  const idEl = document.getElementById('income-modal-edit-id');
  const desc = document.getElementById('income-modal-desc');
  const amount = document.getElementById('income-modal-amount');
  const type = document.getElementById('income-modal-type');
  const date = document.getElementById('income-modal-date');
  const note = document.getElementById('income-modal-note');
  const saveLabel = document.getElementById('income-modal-save-label');
  const subtitle = modal ? modal.querySelector('.income-modal-hero-copy p') : null;
  if (!modal) return;
  const item = editId != null
    ? state.income.find(function (x) { return String(x.id) === String(editId); })
    : null;
  if (title) title.textContent = item ? 'Edit Income' : 'Add Income';
  if (subtitle) {
    subtitle.textContent = item
      ? 'Update the details for this income record.'
      : 'Log a new income source or update an existing one.';
  }
  if (saveLabel) saveLabel.textContent = item ? 'Update Income' : 'Save Income';
  if (idEl) idEl.value = item ? String(item.id) : '';
  if (desc) desc.value = item ? item.desc : '';
  if (amount) amount.value = item ? item.amount : '';
  if (type) type.value = item ? normalizeIncomeType(item.type) : '';
  if (date) date.value = item ? (item.date || todayISO()) : todayISO();
  if (note) note.value = item ? (item.note || '') : '';
  updateIncomeNoteCounter();
  modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function openIncomeDeleteModal(id) {
  const item = state.income.find(function (x) { return String(x.id) === String(id); });
  if (!item) return;
  pendingIncomeDeleteId = item.id;
  const modal = document.getElementById('income-delete-modal');
  const msg = document.getElementById('income-delete-message');
  if (msg) {
    msg.innerHTML = 'Are you sure you want to delete <strong>' + escapeHtml(item.desc || 'this record')
      + '</strong>? This action cannot be undone and will recalculate your total balance.';
  }
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeIncomeDeleteModal() {
  const modal = document.getElementById('income-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingIncomeDeleteId = null;
  unlockBodyScrollIfIdle();
}

function confirmIncomeDelete() {
  if (pendingIncomeDeleteId == null) {
    closeIncomeDeleteModal();
    return;
  }
  const id = pendingIncomeDeleteId;
  pendingIncomeDeleteId = null;
  const modal = document.getElementById('income-delete-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
  state.income = state.income.filter(function (i) { return String(i.id) !== String(id); });
  clearSampleFlagIfNeeded();
  showToast('Income record deleted', 'rose');
  saveUserData();
  checkAchievements();
  renderApp();
}

function updateIncomeNoteCounter() {
  const note = document.getElementById('income-modal-note');
  const count = document.getElementById('income-note-count');
  if (!note || !count) return;
  count.textContent = String(note.value.length) + '/200';
}

function closeIncomeModal() {
  const modal = document.getElementById('income-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitIncomeModal(e) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  clearSampleFlagIfNeeded();
  const editId = document.getElementById('income-modal-edit-id').value;
  const typeVal = document.getElementById('income-modal-type').value;
  if (!typeVal) {
    showToast('Please select an income type', 'rose');
    return;
  }
  const payload = {
    desc: document.getElementById('income-modal-desc').value.trim(),
    amount: parseFloat(document.getElementById('income-modal-amount').value),
    type: normalizeIncomeType(typeVal),
    date: document.getElementById('income-modal-date').value || todayISO(),
    note: (document.getElementById('income-modal-note').value || '').trim().slice(0, 200)
  };
  if (!payload.desc || !(payload.amount > 0)) {
    showToast('Enter a valid source and amount', 'rose');
    return;
  }
  if (editId) {
    const row = state.income.find(function (x) { return String(x.id) === String(editId); });
    if (row) Object.assign(row, payload);
    showToast('Income record updated successfully!', 'success');
  } else {
    state.income.push(Object.assign({ id: Date.now() }, payload));
    triggerCardPulse('card-income');
    showToast('Income added', 'info');
  }
  closeIncomeModal();
  saveUserData();
  checkAchievements();
  renderApp();
}

function populateIncomeSourceFilter() {
  // Source/type filters removed from toolbar — kept as no-op for compatibility
}

function renderIncomeBreakdownAndInsights(chartRows) {
  const total = chartRows.reduce(function (a, i) { return a + Number(i.amount || 0); }, 0) || 0;
  const typeMap = {};
  chartRows.forEach(function (i) {
    const t = normalizeIncomeType(i.type);
    typeMap[t] = (typeMap[t] || 0) + Number(i.amount || 0);
  });
  const labels = INCOME_TYPE_ORDER.filter(function (k) { return typeMap[k] > 0; });
  Object.keys(typeMap).forEach(function (k) {
    if (labels.indexOf(k) === -1 && typeMap[k] > 0) labels.push(k);
  });
  const legend = document.getElementById('income-type-legend');
  if (legend) {
    legend.innerHTML = (labels.length ? labels : INCOME_TYPE_ORDER.slice(0, 3)).map(function (label) {
      const amt = typeMap[label] || 0;
      const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
      const color = INCOME_TYPE_COLORS[label] || '#B46A72';
      return '<li><span class="dot" style="background:' + color + '"></span><span>' + label + '</span>'
        + '<span class="meta">' + peso(amt) + ' · ' + pct + '%</span></li>';
    }).join('');
  }
  const center = document.getElementById('income-donut-total');
  if (center) center.textContent = peso(total).replace(/\.00$/, '');

  const breakdown = document.getElementById('income-breakdown-list');
  if (breakdown) {
    breakdown.innerHTML = (labels.length ? labels : INCOME_TYPE_ORDER.slice(0, 3)).map(function (label) {
      const amt = typeMap[label] || 0;
      const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
      const color = INCOME_TYPE_COLORS[label] || '#B46A72';
      const icon = INCOME_TYPE_ICONS[label] || 'wallet';
      return '<li><div class="ico" style="background:' + color + '22;color:' + color + '"><i data-lucide="' + icon + '"></i></div>'
        + '<div class="copy"><strong>' + label + '</strong><span>' + peso(amt) + ' · ' + pct + '%</span></div></li>';
    }).join('');
  }

  const insights = document.getElementById('income-insights');
  if (insights) {
    let top = null;
    chartRows.forEach(function (i) {
      if (!top || Number(i.amount) > Number(top.amount)) top = i;
    });
    const mom = monthOverMonthPct(state.income);
    const newest = chartRows.slice().sort(function (a, b) { return b.id - a.id; })[0];
    const cards = [
      {
        icon: 'briefcase',
        color: '#B46A72',
        text: top
          ? ('Highest Source: ' + top.desc + ' is your top income source (' + (total > 0 ? Math.round((Number(top.amount) / total) * 100) : 0) + '%).')
          : 'Highest Source: Add income to unlock this insight.'
      },
      {
        icon: 'trending-up',
        color: '#A8B58A',
        text: mom === 0
          ? 'Growing Trend: No change vs last month yet.'
          : ('Growing Trend: Your income ' + (mom > 0 ? 'increased' : 'changed') + ' by ' + Math.abs(mom) + '% vs last month.')
      },
      {
        icon: 'sparkles',
        color: '#A9B7C6',
        text: newest
          ? ('New Source: ' + newest.desc + ' is now contributing to your income.')
          : 'New Source: Log a source to see recent activity.'
      }
    ];
    insights.innerHTML = cards.map(function (c) {
      return '<div class="income-insight"><div class="ico" style="background:' + c.color + '"><i data-lucide="' + c.icon + '"></i></div>'
        + '<p>' + escapeHtml(c.text) + '</p><i data-lucide="chevron-right" class="chev"></i></div>';
    }).join('');
  }
}

function renderIncomePage() {
  if (!document.getElementById('view-income')) return;
  populateIncomeSourceFilter();
  const rows = filterIncomeRows();
  const pageSize = state.incomePageSize || 5;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  if ((state.incomePage || 1) > pages) state.incomePage = pages;
  const page = state.incomePage || 1;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const t = totals();
  const remaining = t.remaining;

  // Running remaining: newest-first list → first row = overall remaining,
  // each next row adds the newer income amounts above it.
  let acc = remaining;
  const fullRun = {};
  rows.forEach(function (i) {
    fullRun[i.id] = acc;
    acc += Number(i.amount || 0);
  });

  const body = document.getElementById('income-table-body');
  if (body) {
    if (!pageRows.length) {
      body.innerHTML = '<tr><td colspan="6" class="text-center text-[var(--ft-muted)] py-6">No income records match your filters</td></tr>';
    } else {
      body.innerHTML = pageRows.map(function (i) {
        const pill = incomeTypeClass(i.type);
        const icon = incomeSourceIcon(i);
        return '<tr>'
          + '<td><div class="income-source-cell"><span class="income-source-icon"><i data-lucide="' + icon + '"></i></span>' + escapeHtml(i.desc) + '</div></td>'
          + '<td><span class="income-type-pill ' + pill + '">' + escapeHtml(normalizeIncomeType(i.type)) + '</span></td>'
          + '<td>' + escapeHtml(i.date || '') + '</td>'
          + '<td class="income-amount-pos">' + peso(i.amount) + '</td>'
          + '<td>' + peso(fullRun[i.id] || 0) + '</td>'
          + '<td><div class="income-row-actions">'
          + '<button type="button" title="Edit" onclick="openIncomeModal(' + i.id + ')"><i data-lucide="pencil"></i></button>'
          + '<button type="button" title="Delete" onclick="openIncomeDeleteModal(' + i.id + ')"><i data-lucide="trash-2"></i></button>'
          + '</div></td></tr>';
      }).join('');
    }
  }

  const info = document.getElementById('income-page-info');
  const num = document.getElementById('income-page-num');
  const fromN = rows.length ? start + 1 : 0;
  const toN = Math.min(rows.length, start + pageSize);
  if (info) info.textContent = 'Showing ' + fromN + '–' + toN + ' of ' + rows.length + ' records';
  if (num) num.textContent = String(page);

  const chartRange = ((document.getElementById('income-chart-range') || {}).value || 'month');
  const trendRange = ((document.getElementById('income-trend-range') || {}).value || 'month');
  const chartRows = incomeInChartRange(state.income, chartRange);
  const trendRows = incomeInChartRange(state.income, trendRange);
  renderIncomeBreakdownAndInsights(chartRows);
  updateIncomeCharts(chartRows, trendRows);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateIncomeCharts(chartRows, trendRows) {
  if (typeof Chart === 'undefined') return;
  const typeOrder = INCOME_TYPE_ORDER.slice();
  const typeMap = {};
  typeOrder.forEach(function (k) { typeMap[k] = 0; });
  chartRows.forEach(function (i) {
    const t = normalizeIncomeType(i.type);
    typeMap[t] = (typeMap[t] || 0) + Number(i.amount || 0);
  });
  const labels = typeOrder.filter(function (k) { return typeMap[k] > 0; });
  const data = labels.map(function (k) { return typeMap[k]; });
  const colors = labels.map(function (k) { return INCOME_TYPE_COLORS[k] || '#B46A72'; });
  destroyChart('income');
  ensureChart('income', 'incomeChart', {
    type: 'doughnut',
    data: {
      labels: labels.length ? labels : ['No data'],
      datasets: [{ data: data.length ? data : [1], backgroundColor: colors.length ? colors : ['#e8e4df'], borderWidth: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      plugins: { legend: { display: false }, tooltip: { enabled: !!labels.length } }
    }
  });

  const barPlugin = {
    id: 'incomeBarLabels',
    afterDatasetsDraw: function (chart) {
      if (chart.canvas.id !== 'incomeTrendChart') return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = '700 10px Nunito, system-ui, sans-serif';
      ctx.fillStyle = chartLabelColor();
      ctx.textAlign = 'center';
      chart.getDatasetMeta(0).data.forEach(function (bar, i) {
        const val = chart.data.datasets[0].data[i];
        if (val == null) return;
        ctx.fillText(peso(val).replace(/\.00$/, ''), bar.x, bar.y - 8);
      });
      ctx.restore();
    }
  };
  const sortedTrend = trendRows.slice().sort(function (a, b) { return Number(b.amount) - Number(a.amount); }).slice(0, 6);
  destroyChart('incomeTrend');
  ensureChart('incomeTrend', 'incomeTrendChart', {
    type: 'bar',
    data: {
      labels: sortedTrend.map(function (i) { return String(i.desc || '').slice(0, 12); }),
      datasets: [{
        data: sortedTrend.map(function (i) { return Number(i.amount); }),
        backgroundColor: '#A8B58A',
        borderRadius: 10,
        maxBarThickness: 42
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      layout: { padding: { top: 18 } },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    }),
    plugins: [barPlugin]
  });
}

const SPEND_MOODS = {
  Happy: { emoji: '😊', color: '#A8B58A' },
  Stressed: { emoji: '😫', color: '#e8a05c' },
  'Treating Myself': { emoji: '😎', color: '#F7C8D3' },
  Necessary: { emoji: '😐', color: '#A9B7C6' }
};

const SPEND_CAT_META = {
  Food: { label: 'Food', icon: 'utensils', color: '#A8B58A' },
  Transportation: { label: 'Transportation', icon: 'bus', color: '#7f9bb8' },
  'Bills & Utilities': { label: 'Bills & Utilities', icon: 'wifi', color: '#A9B7C6' },
  Healthcare: { label: 'Healthcare', icon: 'heart-pulse', color: '#8a9a78' },
  Education: { label: 'Education', icon: 'book-open', color: '#B46A72' },
  Shopping: { label: 'Shopping', icon: 'shopping-bag', color: '#e8a05c' },
  Entertainment: { label: 'Entertainment', icon: 'film', color: '#c48a9a' },
  Gifts: { label: 'Gifts', icon: 'gift', color: '#F7C8D3' },
  'Debt Payments': { label: 'Debt Payments', icon: 'credit-card', color: '#B46A72' },
  'Donations & Charity': { label: 'Donations & Charity', icon: 'heart', color: '#A8B58A' },
  Pets: { label: 'Pets', icon: 'cat', color: '#D4A574' },
  Emergency: { label: 'Emergency', icon: 'alert-triangle', color: '#e8a05c' },
  Rent: { label: 'Rent', icon: 'home', color: '#F7C8D3' },
  'Other Expenses': { label: 'Other Expenses', icon: 'circle-dot', color: '#9aa3ad' }
};
const SPEND_CAT_ORDER = [
  'Food', 'Transportation', 'Bills & Utilities', 'Healthcare', 'Education', 'Shopping',
  'Entertainment', 'Gifts', 'Debt Payments', 'Donations & Charity', 'Pets', 'Emergency',
  'Rent', 'Other Expenses'
];

function monthRangeLabel(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  const fmt = function (d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  return fmt(start) + ' - ' + fmt(end);
}

function populateSpendRangeFilter() {
  const sel = document.getElementById('spend-range-filter');
  if (!sel) return;
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const curVal = sel.value || 'month';
  const opts = [
    { value: 'month', label: monthRangeLabel(now.getFullYear(), now.getMonth()) },
    { value: 'prev', label: monthRangeLabel(prev.getFullYear(), prev.getMonth()) },
    { value: 'all', label: 'All time' }
  ];
  sel.innerHTML = opts.map(function (o) {
    return '<option value="' + o.value + '"' + (o.value === curVal ? ' selected' : '') + '>' + o.label + '</option>';
  }).join('');
}

function expensesInSpendRange(list, rangeVal) {
  const now = new Date();
  if (rangeVal === 'all') return list.slice();
  let y = now.getFullYear();
  let m = now.getMonth();
  if (rangeVal === 'prev') {
    const prev = new Date(y, m - 1, 1);
    y = prev.getFullYear();
    m = prev.getMonth();
  }
  return list.filter(function (e) {
    if (!e.date) return true;
    const d = new Date(e.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });
}

function onSpendFilterChange() {
  renderSpendingPage();
}

function openBudgetLimitModal() {
  if (!ACCOUNT_SYSTEM.getCurrentUser()) {
    showToast('Please sign in first!', 'rose');
    return;
  }
  const modal = document.getElementById('budget-limit-modal');
  const input = document.getElementById('budget-limit-input');
  if (input) input.value = state.settings.budgetLimit > 0 ? state.settings.budgetLimit : '';
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  setTimeout(function () { if (input) input.focus(); }, 40);
}

function closeBudgetLimitModal() {
  const modal = document.getElementById('budget-limit-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitBudgetLimit(e) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) {
    showToast('Please sign in first!', 'rose');
    return;
  }
  const input = document.getElementById('budget-limit-input');
  const val = parseFloat(input && input.value);
  if (!(val >= 0) || Number.isNaN(val)) {
    showToast('Enter a valid spending limit', 'rose');
    return;
  }
  state.settings.budgetLimit = val;
  clearSampleFlagIfNeeded();
  const setBudget = document.getElementById('set-budget');
  if (setBudget) setBudget.value = val;
  closeBudgetLimitModal();
  saveUserData();
  showToast('Spending limit updated!', 'success');
  renderApp();
}

function getExpenseAlertThreshold() {
  const t = Number(state.settings.expenseAlertThreshold);
  return Number.isFinite(t) && t >= 0 ? t : 2000;
}

function openExpenseAlertModal() {
  if (!ACCOUNT_SYSTEM.getCurrentUser()) {
    showToast('Please sign in first!', 'rose');
    return;
  }
  const modal = document.getElementById('expense-alert-modal');
  const input = document.getElementById('expense-alert-input');
  if (input) input.value = getExpenseAlertThreshold();
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
  setTimeout(function () { if (input) input.focus(); }, 40);
}

function closeExpenseAlertModal() {
  const modal = document.getElementById('expense-alert-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitExpenseAlertThreshold(e) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) {
    showToast('Please sign in first!', 'rose');
    return;
  }
  const input = document.getElementById('expense-alert-input');
  const val = parseFloat(input && input.value);
  if (!(val >= 0) || Number.isNaN(val)) {
    showToast('Enter a valid alert amount', 'rose');
    return;
  }
  state.settings.expenseAlertThreshold = val;
  clearSampleFlagIfNeeded();
  const settingsInput = document.getElementById('set-expense-alert');
  if (settingsInput) settingsInput.value = val;
  closeExpenseAlertModal();
  saveUserData();
  showToast('High spending alert updated!', 'success');
  renderApp();
}

function spendCategoryIcon(cat) {
  const meta = SPEND_CAT_META[normalizeSpendCat(cat)] || SPEND_CAT_META['Other Expenses'];
  return meta.icon;
}

function spendMoodMeta(mood) {
  return SPEND_MOODS[mood] || SPEND_MOODS.Necessary;
}

var pendingExpenseDeleteId = null;

function openExpenseModal(editId) {
  const modal = document.getElementById('expense-modal');
  if (!modal) return;
  const item = editId != null
    ? state.expenses.find(function (x) { return String(x.id) === String(editId); })
    : null;
  const title = document.getElementById('expense-modal-title');
  const subtitle = document.getElementById('expense-modal-subtitle');
  const saveLabel = document.getElementById('expense-modal-save-label');
  const idEl = document.getElementById('expense-modal-edit-id');
  if (title) title.textContent = item ? 'Edit Expense' : 'Add Expense';
  if (subtitle) {
    subtitle.textContent = item
      ? 'Update the details for this expense record.'
      : 'Log a new expense or update an existing one.';
  }
  if (saveLabel) saveLabel.textContent = item ? 'Update Expense' : 'Save Expense';
  if (idEl) idEl.value = item ? String(item.id) : '';
  document.getElementById('expense-modal-desc').value = item ? item.desc : '';
  document.getElementById('expense-modal-amount').value = item ? item.amount : '';
  document.getElementById('expense-modal-category').value = item ? normalizeSpendCat(item.category || 'Food') : 'Food';
  document.getElementById('expense-modal-needwant').value = item ? (item.needWant || 'Need') : 'Need';
  const deductEl = document.getElementById('expense-modal-deduct');
  if (deductEl) deductEl.value = item ? normalizeDeductFrom(item.deductFrom) : 'Income';
  document.getElementById('expense-modal-date').value = item ? (item.date || todayISO()) : todayISO();
  document.getElementById('expense-modal-mood').value = item ? (item.mood || 'Necessary') : 'Happy';
  modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeExpenseModal() {
  const modal = document.getElementById('expense-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitExpenseModal(e) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  clearSampleFlagIfNeeded();
  const editId = document.getElementById('expense-modal-edit-id').value;
  const payload = {
    desc: document.getElementById('expense-modal-desc').value.trim(),
    amount: parseFloat(document.getElementById('expense-modal-amount').value),
    category: normalizeSpendCat(document.getElementById('expense-modal-category').value),
    needWant: document.getElementById('expense-modal-needwant').value,
    deductFrom: normalizeDeductFrom((document.getElementById('expense-modal-deduct') || {}).value),
    date: document.getElementById('expense-modal-date').value || todayISO(),
    mood: document.getElementById('expense-modal-mood').value || 'Necessary'
  };
  if (!payload.desc || !(payload.amount > 0)) {
    showToast('Enter a valid description and amount', 'rose');
    return;
  }
  if (editId) {
    const row = state.expenses.find(function (x) { return String(x.id) === String(editId); });
    if (row) Object.assign(row, payload);
    showToast('Expense record updated successfully!', 'success');
  } else {
    state.expenses.push(Object.assign({ id: Date.now() }, payload));
    triggerCardPulse('card-spending');
    showToast('Expense added', 'info');
  }
  closeExpenseModal();
  saveUserData();
  checkAchievements();
  renderApp();
}

function openExpenseDeleteModal(id) {
  const item = state.expenses.find(function (x) { return String(x.id) === String(id); });
  if (!item) return;
  pendingExpenseDeleteId = item.id;
  const modal = document.getElementById('expense-delete-modal');
  const msg = document.getElementById('expense-delete-message');
  if (msg) {
    msg.innerHTML = 'Are you sure you want to delete <strong>' + escapeHtml(item.desc || 'this record')
      + '</strong>? This action cannot be undone and will recalculate your totals.';
  }
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeExpenseDeleteModal() {
  const modal = document.getElementById('expense-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingExpenseDeleteId = null;
  unlockBodyScrollIfIdle();
}

function confirmExpenseDelete() {
  if (pendingExpenseDeleteId == null) {
    closeExpenseDeleteModal();
    return;
  }
  const id = pendingExpenseDeleteId;
  pendingExpenseDeleteId = null;
  const modal = document.getElementById('expense-delete-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
  state.expenses = state.expenses.filter(function (i) { return String(i.id) !== String(id); });
  clearSampleFlagIfNeeded();
  showToast('Expense record deleted', 'rose');
  saveUserData();
  checkAchievements();
  renderApp();
}

function renderSpendingPage() {
  if (!document.getElementById('view-spending')) return;
  populateSpendRangeFilter();
  const rangeVal = ((document.getElementById('spend-range-filter') || {}).value || 'month');
  const rows = expensesInSpendRange(state.expenses, rangeVal).slice().sort(function (a, b) {
    return String(b.date || '').localeCompare(String(a.date || '')) || (b.id - a.id);
  });
  const monthSpend = sumInCalendarMonth(state.expenses, new Date().getFullYear(), new Date().getMonth());
  const budget = Number(state.settings.budgetLimit || 0);
  const remain = Math.max(0, budget - monthSpend);
  const pctUsed = budget > 0 ? Math.min(100, Math.round((monthSpend / budget) * 100)) : 0;
  const mom = monthOverMonthPct(state.expenses);

  const totalEl = document.getElementById('spend-metric-total');
  const budgetEl = document.getElementById('spend-metric-budget');
  const remainEl = document.getElementById('spend-metric-remain');
  const trendEl = document.getElementById('spend-metric-trend');
  const fillEl = document.getElementById('spend-budget-fill');
  const metaEl = document.getElementById('spend-budget-meta');
  const alertEl = document.getElementById('spend-remain-alert');
  if (totalEl) totalEl.textContent = peso(monthSpend);
  if (budgetEl) budgetEl.textContent = peso(budget);
  if (remainEl) remainEl.textContent = peso(budget > 0 ? remain : 0);
  if (fillEl) fillEl.style.width = pctUsed + '%';
  if (metaEl) metaEl.textContent = 'Spent ' + peso(monthSpend) + ' (' + pctUsed + '%)';
  if (trendEl) {
    const abs = Math.abs(mom);
    if (mom === 0) {
      trendEl.textContent = '— 0% vs. last month';
      trendEl.className = 'spend-metric-trend';
    } else if (mom < 0) {
      trendEl.textContent = '↓ ' + abs + '% vs. last month';
      trendEl.className = 'spend-metric-trend is-down';
    } else {
      trendEl.textContent = '↑ ' + abs + '% vs. last month';
      trendEl.className = 'spend-metric-trend is-up';
    }
  }
  if (alertEl) {
    if (!budget) alertEl.textContent = 'Set a budget in Settings to track remaining.';
    else if (remain <= 0) alertEl.textContent = "You've reached your limit! 🎉";
    else if (pctUsed >= 85) alertEl.textContent = 'Almost there — spend carefully.';
    else alertEl.textContent = 'You still have room in this month\'s budget.';
  }

  const body = document.getElementById('spending-table-body');
  if (body) {
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-center text-[var(--ft-muted)] py-6">No expenses in this range</td></tr>';
    } else {
      body.innerHTML = rows.map(function (i) {
        const cat = normalizeSpendCat(i.category || 'Other Expenses');
        const meta = SPEND_CAT_META[cat] || SPEND_CAT_META['Other Expenses'];
        const mood = spendMoodMeta(i.mood);
        const typeClass = i.needWant === 'Want' ? 'is-want' : 'is-need';
        return '<tr>'
          + '<td>' + escapeHtml(i.date || '') + '</td>'
          + '<td class="font-bold">' + escapeHtml(i.desc) + '</td>'
          + '<td><span class="spend-cat-cell"><span class="spend-cat-icon"><i data-lucide="' + meta.icon + '"></i></span>'
          + escapeHtml(meta.label) + '</span></td>'
          + '<td>' + escapeHtml(normalizeDeductFrom(i.deductFrom)) + '</td>'
          + '<td><span class="spend-type-pill ' + typeClass + '">' + escapeHtml(i.needWant || 'Need') + '</span></td>'
          + '<td class="spend-amount-neg">' + peso(i.amount) + '</td>'
          + '<td><span class="spend-mood-badge">' + mood.emoji + ' ' + escapeHtml(i.mood || 'Necessary') + '</span></td>'
          + '<td><div class="spend-row-actions">'
          + '<button type="button" title="Edit" onclick="openExpenseModal(' + i.id + ')"><i data-lucide="pencil"></i></button>'
          + '<button type="button" title="Delete" onclick="openExpenseDeleteModal(' + i.id + ')"><i data-lucide="trash-2"></i></button>'
          + '</div></td></tr>';
      }).join('');
    }
  }

  // Category bars
  const catMap = {};
  rows.forEach(function (e) {
    const c = normalizeSpendCat(e.category || 'Other Expenses');
    catMap[c] = (catMap[c] || 0) + Number(e.amount || 0);
  });
  const catTotal = Object.keys(catMap).reduce(function (a, k) { return a + catMap[k]; }, 0) || 0;
  const catOrder = SPEND_CAT_ORDER.slice();
  const catBars = document.getElementById('spend-category-bars');
  if (catBars) {
    const keys = catOrder.filter(function (k) { return catMap[k] > 0; });
    Object.keys(catMap).forEach(function (k) {
      if (keys.indexOf(k) === -1) keys.push(k);
    });
    if (!keys.length) {
      catBars.innerHTML = '<p class="text-xs text-[var(--ft-muted)]">No category data yet.</p>';
    } else {
      catBars.innerHTML = keys.map(function (k) {
        const meta = SPEND_CAT_META[k] || SPEND_CAT_META['Other Expenses'];
        const amt = catMap[k];
        const pct = catTotal > 0 ? Math.round((amt / catTotal) * 100) : 0;
        return '<div class="spend-bar-row"><div class="top"><strong>' + escapeHtml(meta.label) + '</strong>'
          + '<span>' + peso(amt) + ' · ' + pct + '%</span></div>'
          + '<div class="spend-bar-track"><div class="spend-bar-fill" style="width:' + pct + '%;background:' + meta.color + '"></div></div></div>';
      }).join('');
    }
  }

  // Insights
  const insights = document.getElementById('spend-insights');
  if (insights) {
    const tips = [];
    if (mom < 0) tips.push('You spent ' + Math.abs(mom) + '% less than last month');
    else if (mom > 0) tips.push('Spending is up ' + mom + '% vs last month — review wants');
    else tips.push('Spending is flat vs last month');
    let topCat = null;
    Object.keys(catMap).forEach(function (k) {
      if (!topCat || catMap[k] > catMap[topCat]) topCat = k;
    });
    if (topCat) {
      const meta = SPEND_CAT_META[topCat] || SPEND_CAT_META['Other Expenses'];
      const pct = catTotal > 0 ? Math.round((catMap[topCat] / catTotal) * 100) : 0;
      tips.push(meta.label + ' is your highest spending category (' + pct + '%)');
    }
    let needs = 0;
    let wants = 0;
    rows.forEach(function (e) {
      if (e.needWant === 'Want') wants += Number(e.amount || 0);
      else needs += Number(e.amount || 0);
    });
    const nw = needs + wants;
    if (nw > 0) tips.push('Needs are ' + Math.round((needs / nw) * 100) + '% of filtered spending');
    if (budget > 0 && pctUsed >= 100) tips.push('You have used 100% of this month\'s budget');
    else if (budget > 0) tips.push(pctUsed + '% of your monthly budget is used');
    insights.innerHTML = tips.slice(0, 4).map(function (t) {
      return '<li><span class="check"><i data-lucide="check"></i></span><span>' + escapeHtml(t) + '</span></li>';
    }).join('');
  }

  // Mood bars
  const moodMap = { Happy: 0, Stressed: 0, 'Treating Myself': 0, Necessary: 0 };
  rows.forEach(function (e) {
    const m = e.mood && moodMap[e.mood] != null ? e.mood : 'Necessary';
    moodMap[m] = (moodMap[m] || 0) + Number(e.amount || 0);
  });
  const moodTotal = Object.keys(moodMap).reduce(function (a, k) { return a + moodMap[k]; }, 0) || 0;
  const moodBars = document.getElementById('spend-mood-bars');
  if (moodBars) {
    moodBars.innerHTML = Object.keys(SPEND_MOODS).map(function (k) {
      const amt = moodMap[k] || 0;
      const pct = moodTotal > 0 ? Math.round((amt / moodTotal) * 100) : 0;
      const meta = SPEND_MOODS[k];
      return '<div class="spend-bar-row"><div class="top"><span class="spend-mood-label">' + meta.emoji + ' ' + escapeHtml(k) + '</span>'
        + '<span>' + peso(amt) + ' · ' + pct + '%</span></div>'
        + '<div class="spend-bar-track"><div class="spend-bar-fill" style="width:' + pct + '%;background:' + meta.color + '"></div></div></div>';
    }).join('');
  }

  // Alerts
  const alertThreshold = getExpenseAlertThreshold();
  const thresholdLabel = document.getElementById('spend-alert-threshold-label');
  if (thresholdLabel) thresholdLabel.textContent = peso(alertThreshold);

  const alertList = [];
  if (budget > 0 && monthSpend >= budget) {
    alertList.push({ title: 'Budget exceeded', sub: 'This month', amount: monthSpend - budget, urgent: true, icon: 'alert-triangle' });
  } else if (budget > 0 && monthSpend >= budget * 0.85) {
    alertList.push({ title: 'Approaching budget', sub: 'This month', amount: monthSpend, urgent: true, icon: 'alert-circle' });
  }
  rows.filter(function (e) {
    return Number(e.amount || 0) >= alertThreshold;
  }).slice().sort(function (a, b) {
    return Number(b.amount || 0) - Number(a.amount || 0);
  }).slice(0, 6).forEach(function (e) {
    alertList.push({
      title: e.desc,
      sub: (e.date || '') + ' · ≥ ' + peso(alertThreshold),
      amount: e.amount,
      urgent: Number(e.amount || 0) >= alertThreshold * 1.5,
      icon: Number(e.amount || 0) >= alertThreshold * 1.5 ? 'alert-circle' : 'info'
    });
  });
  const alertsUl = document.getElementById('spend-alerts-list');
  const badge = document.getElementById('spend-alerts-badge');
  if (badge) {
    if (alertList.length) {
      badge.hidden = false;
      badge.textContent = String(alertList.length);
    } else {
      badge.hidden = true;
    }
  }
  if (alertsUl) {
    if (!alertList.length) {
      alertsUl.innerHTML = '<li style="display:block;text-align:center;color:#7a868f;font-size:0.75rem;font-weight:650;">No spending ≥ ' + peso(alertThreshold) + ' right now</li>';
    } else {
      alertsUl.innerHTML = alertList.map(function (a) {
        return '<li><span class="spend-alert-ico ' + (a.urgent ? 'is-urgent' : 'is-info') + '"><i data-lucide="' + a.icon + '"></i></span>'
          + '<div><strong>' + escapeHtml(a.title) + '</strong><span>' + escapeHtml(a.sub) + '</span></div>'
          + '<em>' + peso(a.amount) + '</em></li>';
      }).join('');
    }
  }

  updateSpendingCharts(rows);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateSpendingCharts(rows) {
  if (typeof Chart === 'undefined') return;
  let needs = 0;
  let wants = 0;
  rows.forEach(function (e) {
    if (e.needWant === 'Want') wants += Number(e.amount || 0);
    else needs += Number(e.amount || 0);
  });
  const total = needs + wants;
  const center = document.getElementById('spend-donut-total');
  if (center) center.textContent = peso(total).replace(/\.00$/, '');
  const legend = document.getElementById('spend-needs-legend');
  if (legend) {
    const items = [
      { label: 'Needs', amt: needs, color: '#A8B58A' },
      { label: 'Wants', amt: wants, color: '#F7C8D3' }
    ];
    legend.innerHTML = items.map(function (it) {
      const pct = total > 0 ? Math.round((it.amt / total) * 100) : 0;
      return '<li><span class="dot" style="background:' + it.color + '"></span><span>' + it.label + ' (' + pct + '%)</span>'
        + '<span class="meta">' + peso(it.amt) + '</span></li>';
    }).join('');
  }

  destroyChart('needsWants');
  ensureChart('needsWants', 'needsWantsChart', {
    type: 'doughnut',
    data: {
      labels: ['Needs', 'Wants'],
      datasets: [{ data: [needs || 0.0001, wants || 0.0001], backgroundColor: ['#A8B58A', '#F7C8D3'], borderWidth: 0 }]
    },
    options: Object.assign({}, chartDefaults(), {
      cutout: '72%',
      plugins: { legend: { display: false }, tooltip: { enabled: total > 0 } }
    })
  });

  // Trend by calendar day within filtered set (or current month if empty range)
  const byDay = {};
  rows.forEach(function (e) {
    const key = e.date || todayISO();
    byDay[key] = (byDay[key] || 0) + Number(e.amount || 0);
  });
  let labels = Object.keys(byDay).sort();
  if (!labels.length) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    labels = [1, 8, 15, 22, new Date(y, m + 1, 0).getDate()].map(function (d) {
      return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    });
    labels.forEach(function (k) { byDay[k] = 0; });
  }
  const shortLabels = labels.map(function (iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });
  const data = labels.map(function (k) { return byDay[k] || 0; });
  destroyChart('spendingTrend');
  ensureChart('spendingTrend', 'spendingTrendChart', {
    type: 'line',
    data: {
      labels: shortLabels,
      datasets: [{
        data: data,
        borderColor: '#B46A72',
        borderWidth: 3,
        pointBackgroundColor: '#fff',
        pointBorderColor: '#B46A72',
        pointRadius: 3,
        backgroundColor: function (ctx) {
          return chartAreaGradient(ctx, 'rgba(247, 200, 211, 0.45)', 'rgba(247, 200, 211, 0.02)');
        },
        fill: true,
        tension: 0.35
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });
}

const SAV_CAT_COLORS = {
  'Emergency Fund': '#A8B58A',
  'Short-Term': '#F7C8D3',
  'Medium-Term': '#e8a05c',
  'Long-Term': '#A9B7C6',
  Education: '#B46A72',
  Travel: '#7f9bb8',
  Business: '#9aa3ad',
  Investment: '#D4A574',
  'Home/Property': '#8a9a78',
  Retirement: '#6b7599',
  Other: '#c4b8a8'
};

const SAV_CAT_ICONS = {
  'Emergency Fund': 'shield',
  'Short-Term': 'zap',
  'Medium-Term': 'building-2',
  'Long-Term': 'landmark',
  Education: 'graduation-cap',
  Travel: 'plane',
  Business: 'briefcase',
  Investment: 'line-chart',
  'Home/Property': 'home',
  Retirement: 'clock',
  Other: 'circle-dot'
};

function inferSavingsCategory(item) {
  if (item && item.isEmergency) return 'Emergency Fund';
  return normalizeSavCat(item && item.category); 
}

function savingsGoalIcon(desc) {
  const d = String(desc || '').toLowerCase();
  if (/emergency|ef|vault/.test(d)) return { icon: 'shield', color: '#A8B58A' };
  if (/deposit|bank|time/.test(d)) return { icon: 'building-2', color: '#A9B7C6' };
  if (/vacation|travel|trip/.test(d)) return { icon: 'plane', color: '#7f9bb8' };
  if (/educat|school|laptop/.test(d)) return { icon: 'graduation-cap', color: '#B46A72' };
  if (/bike|gear|want/.test(d)) return { icon: 'bike', color: '#e8a05c' };
  if (/business/.test(d)) return { icon: 'briefcase', color: '#9aa3ad' };
  return { icon: 'target', color: '#B46A72' };
}

function getSavingsOverallTarget() {
  const t = Number(state.settings.savingsOverallTarget);
  return Number.isFinite(t) && t > 0 ? t : 150000;
}

function setSavingsGrowthRange(range) {
  state.savingsGrowthRange = range;
  document.querySelectorAll('#savings-growth-range .sav-range-btn').forEach(function (btn) {
    btn.classList.toggle('active', String(btn.getAttribute('data-range')) === String(range));
  });
  renderSavingsPage();
}

function toDateInputValue(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function openSavingsModal(editId, mode) {
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  const modal = document.getElementById('savings-modal');
  if (!modal) return;
  const item = editId != null ? state.savings.find(function (x) { return String(x.id) === String(editId); }) : null;
  if (editId != null && !item) {
    showToast('Could not find that savings goal.', 'rose');
    return;
  }
  // History rows are archive-only (no edit)
  if (item && item.isCompleted && mode !== 'goal') {
    showToast('Completed history entries can’t be edited — delete instead.', 'info');
    return;
  }
  const resolvedMode = mode || (item ? (item.isCompleted ? 'history' : 'goal') : 'goal');
  const modeEl = document.getElementById('savings-modal-mode');
  if (modeEl) modeEl.value = resolvedMode;

  const isGoal = resolvedMode === 'goal';
  const goalFields = document.getElementById('savings-modal-goal-fields');
  const targetInput = document.getElementById('savings-modal-target');
  const dueInput = document.getElementById('savings-modal-due');
  const targetReq = document.getElementById('savings-target-req');
  const dueReq = document.getElementById('savings-due-req');
  if (goalFields) goalFields.style.display = '';
  if (targetInput) targetInput.required = false;
  if (dueInput) dueInput.required = false;
  if (targetReq) targetReq.style.display = isGoal ? 'inline' : 'none';
  if (dueReq) dueReq.style.display = isGoal ? 'inline' : 'none';

  if (item) {
    document.getElementById('savings-modal-title').textContent = isGoal ? 'Edit Goal' : 'Edit Savings';
    document.getElementById('savings-modal-subtitle').textContent = isGoal
      ? 'Update this savings goal.'
      : 'Update this savings history entry.';
    document.getElementById('savings-modal-save-label').textContent = isGoal ? 'Update Goal' : 'Update Savings';
  } else if (isGoal) {
    document.getElementById('savings-modal-title').textContent = 'Add Goal';
    document.getElementById('savings-modal-subtitle').textContent = 'Create a savings goal with a target and due date.';
    document.getElementById('savings-modal-save-label').textContent = 'Save Goal';
  } else {
    document.getElementById('savings-modal-title').textContent = 'Add Savings History';
    document.getElementById('savings-modal-subtitle').textContent = 'Log a completed or archived savings entry.';
    document.getElementById('savings-modal-save-label').textContent = 'Save History';
  }

  document.getElementById('savings-modal-edit-id').value = item ? String(item.id) : '';
  document.getElementById('savings-modal-desc').value = item ? item.desc : '';
  document.getElementById('savings-modal-amount').value = item ? item.amount : '';
  document.getElementById('savings-modal-monthly').value = item ? (item.monthly || '') : '';
  document.getElementById('savings-modal-target').value = item && item.target != null && item.target !== '' ? item.target : '';
  document.getElementById('savings-modal-due').value = item ? toDateInputValue(item.dueDate) : '';
  document.getElementById('savings-modal-account').value = item ? (item.account || 'Digital Bank') : 'Digital Bank';
  document.getElementById('savings-modal-category').value = item ? inferSavingsCategory(item) : 'Short-Term';
  document.getElementById('savings-modal-date').value = item ? (toDateInputValue(item.date) || todayISO()) : todayISO();
  document.getElementById('savings-modal-emergency').checked = !!(item && item.isEmergency);
  modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeSavingsModal() {
  const modal = document.getElementById('savings-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitSavingsModal(e) {
  e.preventDefault();
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  clearSampleFlagIfNeeded();
  const editId = document.getElementById('savings-modal-edit-id').value;
  const mode = (document.getElementById('savings-modal-mode') || {}).value || 'goal';
  const category = normalizeSavCat(document.getElementById('savings-modal-category').value);
  const isEmergency = document.getElementById('savings-modal-emergency').checked || category === 'Emergency Fund';
  const amount = parseFloat(document.getElementById('savings-modal-amount').value);
  let target = parseFloat(document.getElementById('savings-modal-target').value);
  const dueDate = toDateInputValue(document.getElementById('savings-modal-due').value);
  const startDate = toDateInputValue(document.getElementById('savings-modal-date').value) || todayISO();
  const desc = document.getElementById('savings-modal-desc').value.trim();

  if (!desc) {
    showToast('Enter a description / goal name', 'rose');
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    showToast('Enter a valid amount saved', 'rose');
    return;
  }
  if (mode === 'goal') {
    if (!Number.isFinite(target) || !(target > 0)) {
      showToast('Enter a target amount for this goal', 'rose');
      return;
    }
    if (!dueDate) {
      showToast('Pick a due date for this goal', 'rose');
      return;
    }
  } else if (!Number.isFinite(target) || !(target > 0)) {
    target = amount;
  }

  const payload = {
    desc: desc,
    amount: amount,
    monthly: parseFloat(document.getElementById('savings-modal-monthly').value) || 0,
    target: target,
    dueDate: dueDate,
    account: document.getElementById('savings-modal-account').value,
    category: isEmergency ? 'Emergency Fund' : category,
    date: startDate,
    isEmergency: isEmergency
  };

  if (editId) {
    const row = state.savings.find(function (x) { return String(x.id) === String(editId); });
    if (!row) {
      showToast('Could not update — goal not found.', 'rose');
      return;
    }
    if (row.isCompleted) {
      showToast('Completed history entries can’t be edited.', 'rose');
      return;
    }
    Object.assign(row, payload);
    showToast(mode === 'goal' ? 'Goal updated!' : 'Savings updated!', 'success');
  } else {
    const isCompleted = mode === 'history';
    state.savings.push(Object.assign({
      id: Date.now(),
      isCompleted: isCompleted,
      completedAt: isCompleted ? startDate : undefined
    }, payload));
    triggerCardPulse('card-savings');
    showToast(isCompleted ? 'Savings history added!' : 'Goal added!', 'success');
  }
  closeSavingsModal();
  saveUserData();
  checkAchievements();
  renderApp();
}

function openSavingsGoalModal(editId) {
  openSavingsModal(editId != null ? editId : null, 'goal');
}

function completeSavingsGoal(id, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const item = state.savings.find(function (x) { return String(x.id) === String(id); });
  if (!item || item.isCompleted) return;
  item.isCompleted = true;
  item.date = todayISO();
  item.completedAt = todayISO();
  if (!(Number(item.target) > 0)) item.target = Number(item.amount) || 0;
  clearSampleFlagIfNeeded();
  // Prefer showing the month the goal was completed
  const histSel = document.getElementById('savings-history-month');
  if (histSel) {
    const d = new Date();
    histSel.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  showToast('Goal completed — moved to Savings History!', 'success');
  fireConfetti();
  saveUserData();
  checkAchievements();
  renderApp();
}

function populateSavingsHistoryMonthFilter() {
  const sel = document.getElementById('savings-history-month');
  if (!sel) return;
  const prev = sel.value || 'all';
  const months = {};
  state.savings.filter(function (s) { return !!s.isCompleted; }).forEach(function (s) {
    const raw = s.completedAt || s.date;
    if (!raw) return;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return;
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    months[key] = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  });
  const keys = Object.keys(months).sort().reverse();
  let html = '<option value="all">All months</option>';
  keys.forEach(function (k) {
    html += '<option value="' + k + '">' + months[k] + '</option>';
  });
  // Always include current month option even if empty
  const now = new Date();
  const curKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  if (!months[curKey]) {
    html += '<option value="' + curKey + '">' + now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</option>';
  }
  sel.innerHTML = html;
  if (prev && [].some.call(sel.options, function (o) { return o.value === prev; })) sel.value = prev;
  else sel.value = 'all';
}

var pendingSavingsDeleteId = null;

function openSavingsDeleteModal(id) {
  const item = state.savings.find(function (x) { return String(x.id) === String(id); });
  if (!item) return;
  pendingSavingsDeleteId = item.id;
  const msg = document.getElementById('savings-delete-message');
  if (msg) {
    msg.innerHTML = 'Are you sure you want to delete <strong>' + escapeHtml(item.desc || 'this record') + '</strong>?';
  }
  const modal = document.getElementById('savings-delete-modal');
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeSavingsDeleteModal() {
  const modal = document.getElementById('savings-delete-modal');
  if (modal) modal.style.display = 'none';
  pendingSavingsDeleteId = null;
  unlockBodyScrollIfIdle();
}

function confirmSavingsDelete() {
  if (pendingSavingsDeleteId == null) { closeSavingsDeleteModal(); return; }
  const id = pendingSavingsDeleteId;
  pendingSavingsDeleteId = null;
  const modal = document.getElementById('savings-delete-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
  state.savings = state.savings.filter(function (i) { return String(i.id) !== String(id); });
  clearSampleFlagIfNeeded();
  showToast('Savings record deleted', 'rose');
  saveUserData();
  renderApp();
}

function closeSavingsGoalModal() {
  const modal = document.getElementById('savings-goal-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitSavingsGoalModal(e) {
  e.preventDefault();
  // Legacy modal → route into unified savings goal flow
  closeSavingsGoalModal();
  openSavingsModal(null, 'goal');
}

function openSavingsTargetModal() {
  if (!ACCOUNT_SYSTEM.getCurrentUser()) { showToast('Please sign in first!', 'rose'); return; }
  const modal = document.getElementById('savings-target-modal');
  const input = document.getElementById('savings-target-input');
  if (input) input.value = getSavingsOverallTarget();
  if (modal) modal.style.display = 'flex';
  lockBodyScroll();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeSavingsTargetModal() {
  const modal = document.getElementById('savings-target-modal');
  if (modal) modal.style.display = 'none';
  unlockBodyScrollIfIdle();
}

function submitSavingsTargetModal(e) {
  e.preventDefault();
  const val = parseFloat(document.getElementById('savings-target-input').value);
  if (!(val > 0) || Number.isNaN(val)) {
    showToast('Enter a valid overall target', 'rose');
    return;
  }
  state.settings.savingsOverallTarget = val;
  clearSampleFlagIfNeeded();
  closeSavingsTargetModal();
  saveUserData();
  showToast('Overall savings target updated!', 'success');
  renderApp();
}

function buildSavingsGrowthSeries(monthsCount) {
  const now = new Date();
  const labels = [];
  const monthlyBars = [];
  const cumulative = [];
  const monthlyAvg = state.savings.reduce(function (a, s) { return a + Number(s.monthly || 0); }, 0) || Math.max(500, sum(state.savings) / 12);
  const total = sum(state.savings);
  const n = monthsCount === 'all' ? 18 : Number(monthsCount) || 12;
  let running = Math.max(0, total - monthlyAvg * (n - 1));
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    const bar = Math.max(0, monthlyAvg * (0.75 + ((n - i) % 5) * 0.08));
    monthlyBars.push(Math.round(bar));
    running += bar * 0.35;
    if (i === 0) running = total;
    cumulative.push(Math.round(Math.max(0, running)));
  }
  if (cumulative.length) cumulative[cumulative.length - 1] = Math.round(total);
  return { labels: labels, monthlyBars: monthlyBars, cumulative: cumulative };
}

function renderSavingsPage() {
  if (!document.getElementById('view-savings')) return;
  const t = totals();
  const monthlySav = state.savings.reduce(function (a, s) { return a + Number(s.monthly || 0); }, 0);
  const mom = monthOverMonthPct(state.savings);
  const period = ((document.getElementById('savings-period') || {}).value || 'month');

  const totalEl = document.getElementById('sav-total');
  const rateEl = document.getElementById('sav-rate');
  const efEl = document.getElementById('sav-ef');
  const monthlyEl = document.getElementById('sav-monthly');
  const etaEl = document.getElementById('sav-eta');
  const trendEl = document.getElementById('sav-total-trend');
  const efMonthsEl = document.getElementById('sav-ef-months');
  if (totalEl) totalEl.textContent = peso(t.savings);
  if (rateEl) rateEl.textContent = t.savingsRate.toFixed(1) + '%';
  if (efEl) efEl.textContent = peso(t.ef);
  if (monthlyEl) monthlyEl.textContent = peso(monthlySav);
  if (efMonthsEl) {
    efMonthsEl.textContent = t.efMonths >= 99
      ? 'Strong emergency coverage'
      : ('— ~' + (t.efMonths ? t.efMonths.toFixed(1) : '0') + ' months of expenses');
  }
  if (trendEl) {
    const abs = Math.abs(mom);
    if (mom === 0) { trendEl.textContent = '— 0% vs. last month'; trendEl.className = 'sav-metric-badge'; }
    else if (mom > 0) { trendEl.textContent = '↑ +' + abs + '% vs. last month'; trendEl.className = 'sav-metric-badge'; }
    else { trendEl.textContent = '↓ ' + abs + '% vs. last month'; trendEl.className = 'sav-metric-badge is-up'; }
  }
  if (etaEl) {
    const activeGoals = state.savings.filter(function (s) { return !s.isCompleted; });
    if (!activeGoals.length) etaEl.textContent = 'Goals clear';
    else {
      const g = activeGoals.slice().sort(function (a, b) {
        return String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'));
      })[0];
      if (g.dueDate) {
        const d = new Date(g.dueDate);
        etaEl.textContent = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      } else {
        const left = Math.max(0, (Number(g.target) || 0) - (Number(g.amount) || 0));
        const m = Number(g.monthly || monthlySav || 0);
        etaEl.textContent = m > 0 ? '~' + Math.ceil(left / m) + ' mo' : 'Set monthly ₱';
      }
    }
  }

  // Goals cards = active (not completed) savings
  const goalsRow = document.getElementById('savings-goals-row');
  if (goalsRow) {
    const activeGoals = state.savings.filter(function (s) { return !s.isCompleted; });
    if (!activeGoals.length) {
      goalsRow.innerHTML = '<div class="ft-card p-5 text-sm text-[var(--ft-muted)]">No active goals — click + Add Goal to start.</div>';
    } else {
      goalsRow.innerHTML = activeGoals.map(function (g) {
        const targetAmt = Number(g.target) > 0 ? Number(g.target) : Number(g.amount) || 0;
        const pct = targetAmt > 0 ? Math.min(100, Math.round((Number(g.amount) / targetAmt) * 100)) : 0;
        const meta = savingsGoalIcon(g.desc);
        let status = 'Just Started';
        let statusClass = 'just-started';
        if (pct >= 100) { status = 'Ready'; statusClass = 'on-track'; }
        else if (pct >= 25) { status = 'On Track'; statusClass = 'on-track'; }
        const due = g.dueDate
          ? new Date(g.dueDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
          : 'No due date';
        return '<div class="sav-goal-card">'
          + '<button type="button" class="sav-goal-card-main" onclick="openSavingsModal(' + g.id + ',\'goal\')">'
          + '<div class="sav-goal-ico" style="background:' + meta.color + '"><i data-lucide="' + meta.icon + '"></i></div>'
          + '<h4>' + escapeHtml(g.desc) + '</h4>'
          + '<p class="sav-goal-amt">' + peso(g.amount) + ' / ' + peso(targetAmt) + '</p>'
          + '<div class="sav-goal-track"><div class="sav-goal-fill" style="width:' + pct + '%;background:' + meta.color + '"></div></div>'
          + '<div class="sav-goal-foot"><span>' + pct + '% · ' + escapeHtml(due) + '</span>'
          + '<span class="sav-goal-status ' + statusClass + '">' + status + '</span></div>'
          + '</button>'
          + '<button type="button" class="sav-goal-complete-btn" onclick="completeSavingsGoal(' + g.id + ', event)">'
          + '<i data-lucide="check-circle-2"></i> Mark completed</button>'
          + '</div>';
      }).join('');
    }
  }

  // History table = completed savings only (own month viewer — not page period)
  populateSavingsHistoryMonthFilter();
  const histMonth = ((document.getElementById('savings-history-month') || {}).value || 'all');
  let rows = state.savings.filter(function (s) { return !!s.isCompleted; }).slice().sort(function (a, b) {
    const da = a.completedAt || a.date || '';
    const db = b.completedAt || b.date || '';
    return String(db).localeCompare(String(da)) || (b.id - a.id);
  });
  if (histMonth !== 'all') {
    const parts = histMonth.split('-');
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    rows = rows.filter(function (s) {
      const raw = s.completedAt || s.date;
      if (!raw) return false;
      const d = new Date(raw);
      return d.getFullYear() === y && d.getMonth() === m;
    });
  }
  const body = document.getElementById('savings-table-body');
  if (body) {
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-center text-[var(--ft-muted)] py-6">No completed savings in this month — mark a goal completed</td></tr>';
    } else {
      body.innerHTML = rows.map(function (s) {
        const cat = inferSavingsCategory(s);
        const icon = SAV_CAT_ICONS[cat] || 'piggy-bank';
        const shownDate = s.completedAt || s.date || '—';
        return '<tr>'
          + '<td>' + escapeHtml(shownDate) + '</td>'
          + '<td><span class="sav-desc-cell"><span class="sav-desc-ico"><i data-lucide="' + icon + '"></i></span>'
          + escapeHtml(s.desc) + '</span></td>'
          + '<td>' + escapeHtml(s.account || '') + '</td>'
          + '<td>' + escapeHtml(cat) + '</td>'
          + '<td class="font-black theme-text">' + peso(s.amount) + '</td>'
          + '<td>' + peso(s.monthly || 0) + '</td>'
          + '<td><span class="sav-status-pill done">Completed</span></td>'
          + '<td><div class="sav-row-actions">'
          + '<button type="button" title="Delete" onclick="openSavingsDeleteModal(' + s.id + ')"><i data-lucide="trash-2"></i></button>'
          + '</div></td></tr>';
      }).join('');
    }
  }

  // Overall target: completed history vs still-in-progress goals
  const completedSum = state.savings.reduce(function (a, s) {
    return a + (s.isCompleted ? Number(s.amount || 0) : 0);
  }, 0);
  const activeSum = state.savings.reduce(function (a, s) {
    return a + (!s.isCompleted ? Number(s.amount || 0) : 0);
  }, 0);
  const overallTarget = getSavingsOverallTarget();
  const totalTowardGoal = completedSum + activeSum;
  const overallPct = overallTarget > 0 ? Math.min(100, (totalTowardGoal / overallTarget) * 100) : 0;
  const overallRemain = Math.max(0, overallTarget - totalTowardGoal);
  const ot = document.getElementById('sav-overall-target');
  const of = document.getElementById('sav-overall-fill');
  const op = document.getElementById('sav-overall-pct');
  const os = document.getElementById('sav-overall-saved');
  const oa = document.getElementById('sav-overall-active');
  const or = document.getElementById('sav-overall-remain');
  if (ot) ot.textContent = peso(overallTarget);
  if (of) of.style.width = overallPct.toFixed(1) + '%';
  if (op) op.textContent = overallPct.toFixed(1) + '%';
  if (os) os.textContent = peso(completedSum);
  if (oa) oa.textContent = peso(activeSum);
  if (or) or.textContent = peso(overallRemain);

  // Insights
  const insights = document.getElementById('sav-insights');
  if (insights) {
    const tips = [];
    if (mom > 0) tips.push({ icon: 'check', color: '#A8B58A', text: 'Great job! Your savings grew ' + mom + '% vs last month.' });
    else if (mom < 0) tips.push({ icon: 'info', color: '#A9B7C6', text: 'Savings dipped vs last month — review contributions.' });
    else tips.push({ icon: 'check', color: '#A8B58A', text: 'Savings are steady month over month.' });
    // Rate = total savings balances ÷ total logged income (can exceed 100% if income is incomplete).
    if (t.savingsRate > 100) {
      tips.push({
        icon: 'info',
        color: '#B46A72',
        text: 'Savings are ' + t.savingsRate.toFixed(1) + '% of logged income — balances exceed income. Add missing income entries to correct this.'
      });
    } else if (t.savingsRate >= 20) {
      tips.push({ icon: 'target', color: '#B46A72', text: "You're on track! You've saved " + t.savingsRate.toFixed(1) + '% of your income.' });
    } else {
      tips.push({ icon: 'info', color: '#7f9bb8', text: 'Try raising monthly contribution toward a 20%+ savings rate.' });
    }
    const nextGoal = state.savings.filter(function (g) { return !g.isCompleted && g.dueDate; })
      .sort(function (a, b) { return String(a.dueDate).localeCompare(String(b.dueDate)); })[0];
    if (nextGoal) {
      tips.push({
        icon: 'calendar',
        color: '#F7C8D3',
        text: 'Upcoming milestone: ' + nextGoal.desc + ' by ' + nextGoal.dueDate + '.'
      });
    } else if (t.efMonths < 3) {
      tips.push({ icon: 'shield', color: '#A8B58A', text: 'Grow your emergency fund toward 3+ months of expenses.' });
    }
    insights.innerHTML = tips.slice(0, 4).map(function (tip) {
      return '<li><span class="sav-insight-ico" style="background:' + tip.color + '"><i data-lucide="' + tip.icon + '"></i></span>'
        + '<span>' + escapeHtml(tip.text) + '</span></li>';
    }).join('');
  }

  updateSavingsCharts();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateSavingsCharts() {
  if (typeof Chart === 'undefined') return;
  const range = state.savingsGrowthRange == null ? 12 : state.savingsGrowthRange;
  const series = buildSavingsGrowthSeries(range);
  destroyChart('savings');
  ensureChart('savings', 'savingsChart', {
    type: 'bar',
    data: {
      labels: series.labels,
      datasets: [
        {
          type: 'bar',
          label: 'Monthly',
          data: series.monthlyBars,
          backgroundColor: 'rgba(168, 181, 138, 0.55)',
          borderRadius: 8,
          maxBarThickness: 28,
          order: 2
        },
        {
          type: 'line',
          label: 'Cumulative',
          data: series.cumulative,
          borderColor: '#6f8458',
          borderWidth: 3,
          pointRadius: 3,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#6f8458',
          tension: 0.35,
          fill: false,
          order: 1
        }
      ]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });

  const catMap = {};
  Object.keys(SAV_CAT_COLORS).forEach(function (k) { catMap[k] = 0; });
  state.savings.forEach(function (s) {
    const c = inferSavingsCategory(s);
    catMap[c] = (catMap[c] || 0) + Number(s.amount || 0);
  });
  const labels = Object.keys(catMap).filter(function (k) { return catMap[k] > 0; });
  const data = labels.map(function (k) { return catMap[k]; });
  const colors = labels.map(function (k) { return SAV_CAT_COLORS[k] || '#A8B58A'; });
  const total = data.reduce(function (a, b) { return a + b; }, 0);
  const center = document.getElementById('sav-donut-total');
  if (center) center.textContent = peso(total).replace(/\.00$/, '');
  const legend = document.getElementById('sav-category-legend');
  if (legend) {
    const allCats = Object.keys(SAV_CAT_COLORS);
    legend.innerHTML = allCats.map(function (label) {
      const amt = catMap[label] || 0;
      const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
      return '<li><span class="dot" style="background:' + (SAV_CAT_COLORS[label] || '#A8B58A') + '"></span><span>'
        + escapeHtml(label) + ' (' + pct + '%)</span><span class="meta">' + peso(amt) + '</span></li>';
    }).join('');
  }
  destroyChart('savingsCategory');
  ensureChart('savingsCategory', 'savingsCategoryChart', {
    type: 'doughnut',
    data: {
      labels: labels.length ? labels : ['No data'],
      datasets: [{
        data: labels.length ? data : [1],
        backgroundColor: labels.length ? colors : ['#e5e7eb'],
        borderWidth: 0
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      cutout: '72%',
      plugins: { legend: { display: false }, tooltip: { enabled: labels.length > 0 } }
    })
  });
}

/* ---------- Investment page ---------- */
const INV_CAT_META = {
  'Stocks/Funds': { color: '#B46A72', icon: 'line-chart', short: 'Stocks' },
  'Business': { color: '#A8B58A', icon: 'store', short: 'Business' },
  'Bonds/Fixed Income': { color: '#A9B7C6', icon: 'landmark', short: 'Bonds' },
  'Property': { color: '#D4A574', icon: 'home', short: 'Property' },
  'Retirement Investment': { color: '#6b7599', icon: 'clock', short: 'Retirement' },
  'Mutual Funds / ETFs': { color: '#c48a9a', icon: 'pie-chart', short: 'ETFs' },
  'Cryptocurrency': { color: '#e8a05c', icon: 'bitcoin', short: 'Crypto' },
  'Gold / Precious Metals': { color: '#C6A15B', icon: 'gem', short: 'Gold' },
  'Other': { color: '#C4A8B0', icon: 'circle-dot', short: 'Other' }
};

let pendingInvestmentDeleteId = null;

function investCurrentValue(item) {
  const amount = Number(item.amount) || 0;
  const cv = Number(item.currentValue);
  if (Number.isFinite(cv) && cv >= 0) return cv;
  return estimateInvestCurrentValue(amount, item.date, item.expectedReturn != null ? item.expectedReturn : defaultInvestReturn(item.category));
}

function investGain(item) {
  return investCurrentValue(item) - (Number(item.amount) || 0);
}

function filterInvestmentsByPeriod(list) {
  const period = ((document.getElementById('invest-period') || {}).value || 'year');
  if (period === 'all') return list.slice();
  const now = new Date();
  return list.filter(function (i) {
    if (!i.date) return true;
    const d = new Date(i.date);
    if (Number.isNaN(d.getTime())) return true;
    if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (period === 'year') return d.getFullYear() === now.getFullYear();
    return true;
  });
}

function openInvestmentModal(editId) {
  const modal = document.getElementById('investment-modal');
  if (!modal) return;
  const item = editId != null
    ? state.investments.find(function (i) { return String(i.id) === String(editId); })
    : null;
  document.getElementById('investment-modal-edit-id').value = item ? String(item.id) : '';
  document.getElementById('investment-modal-title').textContent = item ? 'Edit Investment' : 'Add Investment';
  document.getElementById('investment-modal-subtitle').textContent = item
    ? 'Update this holding.'
    : 'Log an asset or update an existing holding.';
  document.getElementById('investment-modal-save-label').textContent = item ? 'Update Investment' : 'Save Investment';
  document.getElementById('investment-modal-desc').value = item ? item.desc : '';
  document.getElementById('investment-modal-amount').value = item ? item.amount : '';
  document.getElementById('investment-modal-current').value = item && item.currentValue != null ? item.currentValue : '';
  document.getElementById('investment-modal-monthly').value = item && item.monthly ? item.monthly : '';
  document.getElementById('investment-modal-return').value = item && item.expectedReturn != null ? item.expectedReturn : '';
  document.getElementById('investment-modal-category').value = item ? normalizeInvestCat(item.category) : 'Stocks/Funds';
  document.getElementById('investment-modal-date').value = item ? (toDateInputValue(item.date) || todayISO()) : todayISO();
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeInvestmentModal() {
  const modal = document.getElementById('investment-modal');
  if (modal) modal.style.display = 'none';
}

function submitInvestmentModal(e) {
  e.preventDefault();
  const desc = document.getElementById('investment-modal-desc').value.trim();
  const amount = parseFloat(document.getElementById('investment-modal-amount').value);
  const currentRaw = document.getElementById('investment-modal-current').value;
  const monthly = parseFloat(document.getElementById('investment-modal-monthly').value) || 0;
  const returnRaw = document.getElementById('investment-modal-return').value;
  const category = normalizeInvestCat(document.getElementById('investment-modal-category').value);
  const date = toDateInputValue(document.getElementById('investment-modal-date').value) || todayISO();
  if (!desc || !(amount >= 0) || Number.isNaN(amount)) {
    showToast('Enter a valid asset and amount', 'rose');
    return;
  }
  const expectedReturn = returnRaw === '' || returnRaw == null
    ? defaultInvestReturn(category)
    : Math.max(0, parseFloat(returnRaw) || 0);
  let currentValue = currentRaw === '' || currentRaw == null
    ? estimateInvestCurrentValue(amount, date, expectedReturn)
    : parseFloat(currentRaw);
  if (!Number.isFinite(currentValue) || currentValue < 0) currentValue = amount;

  const editId = document.getElementById('investment-modal-edit-id').value;
  const payload = {
    desc: desc,
    amount: amount,
    currentValue: currentValue,
    monthly: monthly,
    expectedReturn: expectedReturn,
    category: category,
    date: date
  };

  clearSampleFlagIfNeeded();
  if (editId) {
    const idx = state.investments.findIndex(function (i) { return String(i.id) === String(editId); });
    if (idx >= 0) state.investments[idx] = Object.assign({}, state.investments[idx], payload);
    showToast('Investment updated!', 'success');
  } else {
    state.investments.push(Object.assign({ id: Date.now() }, payload));
    showToast('Investment saved!', 'success');
    fireConfetti();
    triggerCardPulse('card-investments');
  }
  closeInvestmentModal();
  saveUserData();
  renderApp();
  checkAchievements();
}

function openInvestmentDeleteModal(id) {
  pendingInvestmentDeleteId = id;
  const item = state.investments.find(function (i) { return String(i.id) === String(id); });
  const msg = document.getElementById('investment-delete-message');
  if (msg) {
    msg.textContent = item
      ? 'Delete “' + item.desc + '”? This will update your portfolio totals.'
      : 'Are you sure you want to delete this investment?';
  }
  const modal = document.getElementById('investment-delete-modal');
  if (modal) modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeInvestmentDeleteModal() {
  pendingInvestmentDeleteId = null;
  const modal = document.getElementById('investment-delete-modal');
  if (modal) modal.style.display = 'none';
}

function confirmInvestmentDelete() {
  if (pendingInvestmentDeleteId == null) return;
  const id = pendingInvestmentDeleteId;
  closeInvestmentDeleteModal();
  clearSampleFlagIfNeeded();
  state.investments = state.investments.filter(function (i) { return String(i.id) !== String(id); });
  saveUserData();
  showToast('Investment deleted', 'success');
  renderApp();
}

function setInvestGrowthRange(range) {
  state.investGrowthRange = range;
  document.querySelectorAll('#invest-growth-range .inv-range-btn').forEach(function (btn) {
    btn.classList.toggle('active', String(btn.getAttribute('data-range')) === String(range));
  });
  renderInvestmentPage();
}

function buildInvestGrowthSeries(monthsCount) {
  const now = new Date();
  const labels = [];
  const values = [];
  const portfolio = state.investments.reduce(function (a, i) { return a + investCurrentValue(i); }, 0);
  const monthly = state.investments.reduce(function (a, i) { return a + Number(i.monthly || 0); }, 0)
    || Math.max(300, portfolio / 18);
  const n = monthsCount === 'all' ? 18 : Number(monthsCount) || 12;
  let running = Math.max(0, portfolio - monthly * (n - 1) * 0.9);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    running += monthly * (0.7 + ((n - i) % 4) * 0.08);
    if (i === 0) running = portfolio;
    values.push(Math.round(Math.max(0, running)));
  }
  if (values.length) values[values.length - 1] = Math.round(portfolio);
  return { labels: labels, values: values };
}

function renderInvestmentPage() {
  if (!document.getElementById('view-investment')) return;
  const all = state.investments || [];
  const rows = filterInvestmentsByPeriod(all);
  const useRows = rows.length ? rows : all;

  const costBasis = useRows.reduce(function (a, i) { return a + (Number(i.amount) || 0); }, 0);
  const portfolio = useRows.reduce(function (a, i) { return a + investCurrentValue(i); }, 0);
  const gain = portfolio - costBasis;
  const gainPct = costBasis > 0 ? (gain / costBasis) * 100 : 0;
  const monthly = all.reduce(function (a, i) { return a + Number(i.monthly || 0); }, 0);
  const mom = monthOverMonthPct(all);
  const weightedReturn = portfolio > 0
    ? useRows.reduce(function (a, i) {
      const cv = investCurrentValue(i);
      const rate = Number(i.expectedReturn);
      const r = Number.isFinite(rate) ? rate : defaultInvestReturn(i.category);
      return a + cv * r;
    }, 0) / portfolio
    : 0;

  const setText = function (id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('inv-total', peso(costBasis));
  const gainEl = document.getElementById('inv-gain');
  if (gainEl) {
    gainEl.textContent = (gain >= 0 ? '+' : '−') + peso(Math.abs(gain));
    gainEl.style.color = gain >= 0 ? '#5a6d45' : '#B46A72';
  }
  setText('inv-portfolio', peso(portfolio));
  setText('inv-monthly', peso(monthly));
  setText('inv-return', weightedReturn.toFixed(1) + '%');

  const trendTotal = document.getElementById('inv-total-trend');
  if (trendTotal) {
    const abs = Math.abs(mom);
    if (mom === 0) { trendTotal.textContent = '— 0% vs. last month'; trendTotal.className = 'inv-metric-badge'; }
    else if (mom > 0) { trendTotal.textContent = '↑ +' + abs + '% vs. last month'; trendTotal.className = 'inv-metric-badge'; }
    else { trendTotal.textContent = '↓ ' + abs + '% vs. last month'; trendTotal.className = 'inv-metric-badge is-down'; }
  }
  const gainTrend = document.getElementById('inv-gain-trend');
  if (gainTrend) {
    gainTrend.textContent = (gainPct >= 0 ? '+' : '') + gainPct.toFixed(1) + '% of cost basis';
    gainTrend.className = 'inv-metric-badge' + (gainPct < 0 ? ' is-down' : '');
  }
  const portTrend = document.getElementById('inv-portfolio-trend');
  if (portTrend) {
    const abs = Math.abs(mom);
    if (mom === 0) { portTrend.textContent = '— 0% vs. last month'; portTrend.className = 'inv-metric-badge'; }
    else if (mom > 0) { portTrend.textContent = '↑ +' + abs + '% vs. last month'; portTrend.className = 'inv-metric-badge'; }
    else { portTrend.textContent = '↓ ' + abs + '% vs. last month'; portTrend.className = 'inv-metric-badge is-down'; }
  }
  const monthlyTrend = document.getElementById('inv-monthly-trend');
  if (monthlyTrend) monthlyTrend.textContent = monthly > 0 ? 'planned deposits' : 'set monthly ₱ on holdings';

  // Category maps (by current value)
  const catMap = {};
  Object.keys(INV_CAT_META).forEach(function (k) { catMap[k] = 0; });
  useRows.forEach(function (i) {
    const c = normalizeInvestCat(i.category);
    catMap[c] = (catMap[c] || 0) + investCurrentValue(i);
  });
  const catKeys = Object.keys(INV_CAT_META);
  const activeCats = catKeys.filter(function (k) { return catMap[k] > 0; });
  let topCat = null;
  activeCats.forEach(function (k) {
    if (!topCat || catMap[k] > catMap[topCat]) topCat = k;
  });

  // Donut + legend
  const center = document.getElementById('inv-donut-total');
  if (center) {
    const totalTxt = peso(portfolio);
    center.textContent = totalTxt.length > 11 ? totalTxt.replace(/\.00$/, '') : totalTxt;
  }
  const legend = document.getElementById('inv-category-legend');
  if (legend) {
    legend.innerHTML = catKeys.map(function (label) {
      const amt = catMap[label] || 0;
      const pct = portfolio > 0 ? Math.round((amt / portfolio) * 100) : 0;
      const meta = INV_CAT_META[label];
      return '<li' + (amt <= 0 ? ' class="is-empty"' : '') + '>'
        + '<span class="dot" style="background:' + meta.color + '"></span>'
        + '<span class="name">' + escapeHtml(label) + ' (' + pct + '%)</span>'
        + '<span class="meta">' + peso(amt) + '</span></li>';
    }).join('');
  }
  const banner = document.getElementById('inv-diversify-text');
  if (banner) {
    if (!useRows.length) banner.textContent = 'Add investments to build your portfolio.';
    else if (activeCats.length >= 3) banner.textContent = 'Your portfolio is well diversified across ' + activeCats.length + ' asset classes.';
    else if (topCat) {
      const pct = portfolio > 0 ? Math.round((catMap[topCat] / portfolio) * 100) : 0;
      banner.textContent = topCat + ' makes up ' + pct + '% of your portfolio — consider diversifying.';
    }
  }

  destroyChart('invest');
  ensureChart('invest', 'investChart', {
    type: 'doughnut',
    data: {
      labels: activeCats.length ? activeCats : ['No data'],
      datasets: [{
        data: activeCats.length ? activeCats.map(function (k) { return catMap[k]; }) : [1],
        backgroundColor: activeCats.length ? activeCats.map(function (k) { return INV_CAT_META[k].color; }) : ['#e5e7eb'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      layout: { padding: 2 },
      plugins: { legend: { display: false }, tooltip: { enabled: activeCats.length > 0 } }
    })
  });

  // Growth chart
  const range = state.investGrowthRange || 12;
  document.querySelectorAll('#invest-growth-range .inv-range-btn').forEach(function (btn) {
    btn.classList.toggle('active', String(btn.getAttribute('data-range')) === String(range));
  });
  const series = buildInvestGrowthSeries(range);
  destroyChart('investGrowth');
  ensureChart('investGrowth', 'investGrowthChart', {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [{
        label: 'Portfolio',
        data: series.values,
        borderColor: '#B46A72',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.4,
        fill: true,
        backgroundColor: function (ctx) {
          return chartAreaGradient(ctx, 'rgba(247, 200, 211, 0.45)', 'rgba(247, 200, 211, 0.02)');
        }
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });

  // Asset mini cards (compact amounts so labels don't crush)
  function pesoCompact(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs >= 100000) return '₱' + (v / 1000).toFixed(0) + 'k';
    if (abs >= 1000) return '₱' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '₱' + v.toFixed(0);
  }
  const minis = document.getElementById('inv-asset-minis');
  if (minis) {
    minis.innerHTML = catKeys.map(function (k) {
      const meta = INV_CAT_META[k];
      const amt = catMap[k] || 0;
      const pct = portfolio > 0 ? Math.round((amt / portfolio) * 100) : 0;
      const empty = amt <= 0 ? ' is-empty' : '';
      return '<div class="inv-asset-mini' + empty + '" style="--inv-accent:' + meta.color + '">'
        + '<span class="inv-asset-mini-ico"><i data-lucide="' + meta.icon + '"></i></span>'
        + '<div class="inv-asset-mini-copy">'
        + '<strong>' + escapeHtml(meta.short) + '</strong>'
        + '<em>' + pesoCompact(amt) + '<span>· ' + pct + '%</span></em>'
        + '</div></div>';
    }).join('');
  }

  // Allocation bars — show all classes so the card feels complete
  const bars = document.getElementById('inv-alloc-bars');
  if (bars) {
    if (!useRows.length) {
      bars.innerHTML = '<p class="inv-alloc-empty">No allocation data yet.</p>';
    } else {
      bars.innerHTML = catKeys.map(function (k) {
        const meta = INV_CAT_META[k];
        const amt = catMap[k] || 0;
        const pct = portfolio > 0 ? Math.round((amt / portfolio) * 100) : 0;
        return '<div class="inv-alloc-row' + (amt <= 0 ? ' is-empty' : '') + '">'
          + '<div class="top">'
          + '<span class="inv-alloc-label"><span class="inv-alloc-dot" style="background:' + meta.color + '"></span>' + escapeHtml(k) + '</span>'
          + '<span class="inv-alloc-pct">' + pct + '%</span></div>'
          + '<div class="inv-alloc-track"><div class="inv-alloc-fill" style="width:' + Math.max(pct, amt > 0 ? 2 : 0) + '%;background:' + meta.color + '"></div></div>'
          + '<div class="meta">' + peso(amt) + '</div></div>';
      }).join('');
    }
  }

  // Table
  const body = document.getElementById('investment-table-body');
  if (body) {
    const tableRows = filterInvestmentsByPeriod(all);
    if (!tableRows.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-center text-[var(--ft-muted)] py-6">No investments in this period</td></tr>';
    } else {
      body.innerHTML = tableRows.slice().sort(function (a, b) {
        return String(b.date || '').localeCompare(String(a.date || ''));
      }).map(function (i) {
        const cat = normalizeInvestCat(i.category);
        const meta = INV_CAT_META[cat] || INV_CAT_META.Other;
        const cv = investCurrentValue(i);
        const g = cv - (Number(i.amount) || 0);
        const gp = Number(i.amount) > 0 ? (g / Number(i.amount)) * 100 : 0;
        const gainClass = g >= 0 ? 'is-up' : 'is-down';
        const gainLabel = (g >= 0 ? '▲ +' : '▼ −') + peso(Math.abs(g)) + ' (' + (gp >= 0 ? '+' : '') + gp.toFixed(1) + '%)';
        const status = g >= 0 ? 'On Track' : 'Watch';
        const statusClass = g >= 0 ? 'on-track' : 'watch';
        return '<tr>'
          + '<td><span class="inv-asset-cell"><span class="inv-asset-ico" style="background:' + meta.color + '22;color:' + meta.color + '"><i data-lucide="' + meta.icon + '"></i></span>'
          + '<strong>' + escapeHtml(i.desc) + '</strong></span></td>'
          + '<td>' + escapeHtml(cat) + '</td>'
          + '<td>' + escapeHtml(i.date || '') + '</td>'
          + '<td class="font-bold">' + peso(i.amount) + '</td>'
          + '<td class="font-bold">' + peso(cv) + '</td>'
          + '<td><span class="inv-gain-pill ' + gainClass + '">' + gainLabel + '</span></td>'
          + '<td><span class="inv-status-pill ' + statusClass + '">' + status + '</span></td>'
          + '<td><div class="inv-row-actions">'
          + '<button type="button" title="Edit" onclick="openInvestmentModal(' + i.id + ')"><i data-lucide="pencil"></i></button>'
          + '<button type="button" title="Delete" onclick="openInvestmentDeleteModal(' + i.id + ')"><i data-lucide="trash-2"></i></button>'
          + '</div></td></tr>';
      }).join('');
    }
  }

  // Footer widgets
  let topAsset = null;
  all.forEach(function (i) {
    const gp = Number(i.amount) > 0 ? (investGain(i) / Number(i.amount)) * 100 : 0;
    if (!topAsset || gp > topAsset.gp) topAsset = { item: i, gp: gp };
  });
  setText('inv-top-asset', topAsset ? topAsset.item.desc : '—');
  setText('inv-top-asset-pct', topAsset ? ((topAsset.gp >= 0 ? '+' : '') + topAsset.gp.toFixed(1) + '%') : '—');
  setText('inv-top-alloc', topCat || '—');
  setText('inv-top-alloc-pct', topCat && portfolio > 0 ? Math.round((catMap[topCat] / portfolio) * 100) + '%' : '—');

  const milestones = [15000, 50000, 100000, 250000];
  const fullPortfolio = all.reduce(function (a, i) { return a + investCurrentValue(i); }, 0);
  let nextMs = milestones.find(function (m) { return fullPortfolio < m; }) || (Math.ceil((fullPortfolio + 1) / 50000) * 50000);
  const msPct = nextMs > 0 ? Math.min(100, (fullPortfolio / nextMs) * 100) : 0;
  setText('inv-milestone', peso(nextMs) + ' Total');
  const msFill = document.getElementById('inv-milestone-fill');
  if (msFill) msFill.style.width = msPct.toFixed(1) + '%';

  // Investment goals (derived from portfolio milestones)
  const goalsList = document.getElementById('inv-goals-list');
  if (goalsList) {
    const defaults = [
      { desc: 'Build Long-Term Wealth', current: fullPortfolio * 0.45, target: Math.max(10000, fullPortfolio * 1.2) },
      { desc: 'Buy a Property', current: (catMap.Property || 0), target: Math.max(50000, (catMap.Property || 0) + 40000) },
      { desc: 'Financial Freedom', current: fullPortfolio, target: Math.max(150000, nextMs) }
    ];
    goalsList.innerHTML = defaults.map(function (g) {
      const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
      return '<div class="inv-goal-row"><div class="top"><strong>' + escapeHtml(g.desc) + '</strong><span>' + pct + '%</span></div>'
        + '<div class="inv-goal-track"><div class="inv-goal-fill" style="width:' + pct + '%"></div></div>'
        + '<div class="meta">' + peso(g.current) + ' / ' + peso(g.target) + '</div></div>';
    }).join('');
  }

  // Insights
  const insights = document.getElementById('inv-insights');
  if (insights) {
    const tips = [];
    if (mom > 0) tips.push({ icon: 'check', color: '#A8B58A', text: 'Your portfolio grew by ' + Math.abs(mom) + '% this month.' });
    else if (mom < 0) tips.push({ icon: 'info', color: '#A9B7C6', text: 'Portfolio additions dipped vs last month.' });
    else tips.push({ icon: 'check', color: '#A8B58A', text: 'Portfolio contributions are steady month over month.' });
    if (topCat) {
      const pct = portfolio > 0 ? Math.round((catMap[topCat] / portfolio) * 100) : 0;
      tips.push({ icon: 'target', color: '#B46A72', text: topCat + ' is your largest allocation (' + pct + '%).' });
    }
    if (gain > 0) tips.push({ icon: 'trending-up', color: '#A8B58A', text: 'Unrealized gains of ' + peso(gain) + ' so far.' });
    else if (gain < 0) tips.push({ icon: 'info', color: '#B46A72', text: 'Paper loss of ' + peso(Math.abs(gain)) + ' — stay the course if thesis holds.' });
    if (activeCats.length < 3 && useRows.length) tips.push({ icon: 'sparkles', color: '#7f9bb8', text: 'Try adding another asset class for better diversification.' });
    if (monthly > 0) tips.push({ icon: 'repeat', color: '#B46A72', text: 'You plan ' + peso(monthly) + '/mo in contributions.' });
    insights.innerHTML = tips.slice(0, 4).map(function (t) {
      return '<li><span class="inv-insight-ico" style="background:' + t.color + '33;color:' + t.color + '"><i data-lucide="' + t.icon + '"></i></span><span>' + escapeHtml(t.text) + '</span></li>';
    }).join('') || '<li class="text-xs text-[var(--ft-muted)]">Add investments to unlock insights.</li>';
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderModuleTables() {
  renderIncomePage();
  renderSpendingPage();
  renderSavingsPage();
  renderInvestmentPage();
  renderProtectionPage();
}

function renderProtectionPage() {
  if (!document.getElementById('view-protection')) return;

  const PROT_TYPES = [
    { key: 'Health Insurance', icon: 'heart-pulse', color: '#A8B58A', desc: 'Medical and health coverage' },
    { key: 'Life Insurance', icon: 'heart', color: '#7f9bb8', desc: 'Life insurance for dependents' },
    { key: 'Property Insurance', icon: 'home', color: '#B46A72', desc: 'Home / property protection' },
    { key: 'Insurance Coverage', icon: 'shield', color: '#9b8ec4', desc: 'General insurance policies' },
    { key: 'Emergency Protection', icon: 'piggy-bank', color: '#D4A574', desc: 'Cash buffer for emergencies' },
    { key: 'Personal Accident Insurance', icon: 'bandage', color: '#e8a05c', desc: 'Accident and injury coverage' },
    { key: 'Family Insurance', icon: 'users', color: '#c48a9a', desc: 'Family and dependents coverage' },
    { key: 'Disability Insurance', icon: 'person-standing', color: '#6b7599', desc: 'Income protection if disabled' },
    { key: 'Other Protection', icon: 'umbrella', color: '#9aa3ad', desc: 'Other protection policies' }
  ];

  const period = ((document.getElementById('prot-period') || {}).value || 'year');
  const now = new Date();
  const all = state.protection || [];
  const filtered = all.filter(function (p) {
    if (period === 'all' || !p.date) return true;
    const d = new Date(p.date);
    if (Number.isNaN(d.getTime())) return true;
    if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return d.getFullYear() === now.getFullYear();
  });
  const rows = filtered.length ? filtered : all;

  const t = totals();
  const pScores = pillarScores();
  const score = pScores.protection;
  const have = new Set(all.map(function (x) { return normalizeProtType(x.policyType); }));
  const covered = PROT_TYPES.filter(function (x) { return have.has(x.key); });
  const missing = PROT_TYPES.filter(function (x) { return !have.has(x.key); });
  const coveredCount = covered.length;
  const totalTypes = PROT_TYPES.length;
  const missingCount = missing.length;
  const covPct = Math.round((coveredCount / totalTypes) * 100);
  const efMonths = t.efMonths;
  const efPct = Math.min(100, (efMonths / 6) * 100);
  const monthlyCost = all.reduce(function (a, i) { return a + (Number(i.monthly) || 0); }, 0);
  const incomeMonthly = t.income > 0 ? t.income : 0;
  const costPct = incomeMonthly > 0 ? (monthlyCost / incomeMonthly) * 100 : 0;
  const mom = monthOverMonthPct(all);

  function scoreLabel(s) {
    if (s >= 80) return { text: 'Good', cls: '' };
    if (s >= 55) return { text: 'Fair', cls: 'is-warn' };
    return { text: 'Needs Work', cls: 'is-warn' };
  }
  function efLabel(m) {
    if (m >= 3) return { text: 'Strong (' + m.toFixed(1) + ' mo)', badge: 'On Track', cls: '', insight: "You're on track! Keep building your emergency fund to stay prepared for unexpected expenses." };
    if (m >= 1) return { text: 'Building (' + m.toFixed(1) + ' mo)', badge: 'Growing', cls: 'is-warn', insight: 'Good start — push toward 3 months of expenses for a stronger buffer.' };
    if (m > 0) return { text: 'Starting (' + m.toFixed(1) + ' mo)', badge: 'Low', cls: 'is-warn', insight: 'Build toward at least 1 month of expenses.' };
    return { text: 'Missing', badge: 'Not Set', cls: 'is-warn', insight: 'Start an emergency fund to cover unexpected expenses.' };
  }

  const sl = scoreLabel(score);
  const ef = efLabel(efMonths >= 99 ? 6 : efMonths);

  const setText = function (id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('prot-score', score + '/100');
  const scoreBadge = document.getElementById('prot-score-badge');
  if (scoreBadge) { scoreBadge.textContent = sl.text; scoreBadge.className = 'prot-badge ' + sl.cls; }

  const scoreTrend = document.getElementById('prot-score-trend');
  if (scoreTrend) {
    const abs = Math.abs(mom);
    if (mom === 0) scoreTrend.textContent = '— 0% vs. last month';
    else if (mom > 0) scoreTrend.textContent = '↑ +' + abs + '% vs. last month';
    else scoreTrend.textContent = '↓ ' + abs + '% vs. last month';
  }

  setText('prot-coverage', coveredCount + '/' + totalTypes + ' covered');
  const missBadge = document.getElementById('prot-missing-badge');
  if (missBadge) {
    missBadge.textContent = missingCount + ' missing';
    missBadge.className = 'prot-badge ' + (missingCount ? 'is-warn' : '');
  }
  const covFill = document.getElementById('prot-coverage-fill');
  if (covFill) covFill.style.width = covPct + '%';
  setText('prot-coverage-list', covered.length ? covered.map(function (c) { return c.key; }).join(' · ') : 'No coverage yet');

  setText('prot-ef-status', ef.text);
  const efBadge = document.getElementById('prot-ef-badge');
  if (efBadge) { efBadge.textContent = ef.badge; efBadge.className = 'prot-badge ' + ef.cls; }
  const efFill = document.getElementById('prot-ef-fill');
  if (efFill) efFill.style.width = efPct.toFixed(1) + '%';

  setText('prot-monthly-cost', peso(monthlyCost));
  setText('prot-cost-pct', costPct.toFixed(1) + '% of monthly income');

  // EF detail card
  setText('prot-ef-detail-status', ef.text.replace(/\s*\(.*/, '') || ef.text);
  setText('prot-ef-detail-copy', efMonths > 0
    ? ('Your emergency fund can cover ' + (efMonths >= 99 ? '6+' : efMonths.toFixed(1)) + ' months of your monthly expenses.')
    : 'Start an emergency fund to cover unexpected expenses.');
  const efDetailFill = document.getElementById('prot-ef-detail-fill');
  if (efDetailFill) efDetailFill.style.width = efPct.toFixed(1) + '%';
  setText('prot-ef-detail-months', (efMonths >= 99 ? '6+' : efMonths.toFixed(1)) + ' mo');
  setText('prot-ef-insight-text', ef.insight);
  const efInsight = document.getElementById('prot-ef-insight');
  if (efInsight) efInsight.classList.toggle('is-warn', efMonths < 3);

  // Checklist
  setText('prot-check-progress', coveredCount + '/' + totalTypes + ' completed');
  const list = document.getElementById('prot-checklist');
  if (list) {
    list.innerHTML = PROT_TYPES.map(function (item) {
      const ok = have.has(item.key);
      return '<li class="prot-check-item' + (ok ? ' is-covered' : ' is-missing') + '" onclick="openProtectionModal(null,\'' + item.key + '\')">'
        + '<span class="prot-check-ico" style="background:' + item.color + '22;color:' + item.color + '"><i data-lucide="' + item.icon + '"></i></span>'
        + '<div><strong>' + escapeHtml(item.key) + '</strong>'
        + '<span>' + escapeHtml(item.desc) + '</span></div>'
        + '<em class="prot-status-tag ' + (ok ? 'ok' : 'no') + '">' + (ok ? '✔ Covered' : '✖ Not Set') + '</em>'
        + '<i data-lucide="chevron-right" class="prot-chevron"></i></li>';
    }).join('');
  }

  // Recommendations
  const recs = document.getElementById('prot-recs');
  if (recs) {
    const tips = [];
    missing.forEach(function (m) {
      tips.push({
        icon: m.icon,
        color: m.color,
        title: 'Add ' + m.key,
        desc: 'Add ' + m.key.toLowerCase() + ' to raise your Protection score.',
        type: m.key
      });
    });
    if (efMonths < 3) {
      tips.push({
        icon: 'piggy-bank',
        color: '#D4A574',
        title: 'Maintain Emergency Protection',
        desc: 'Grow toward 3–6 months of spending for a stronger buffer.',
        type: 'Emergency Protection'
      });
    }
    if (have.has('Life Insurance')) {
      tips.push({
        icon: 'shield',
        color: '#7f9bb8',
        title: 'Review Life Insurance',
        desc: 'Confirm coverage still matches your dependents and income.',
        type: 'Life Insurance'
      });
    }
    if (!tips.length) {
      tips.push({
        icon: 'check-circle-2',
        color: '#A8B58A',
        title: 'Coverage looks solid',
        desc: 'Review policies annually to stay protected.',
        type: 'Health Insurance'
      });
    }
    recs.innerHTML = tips.slice(0, 4).map(function (r) {
      return '<li class="prot-rec-item" onclick="openProtectionModal(null,\'' + r.type + '\')">'
        + '<span class="prot-rec-ico" style="background:' + r.color + '22;color:' + r.color + '"><i data-lucide="' + r.icon + '"></i></span>'
        + '<div><strong>' + escapeHtml(r.title) + '</strong><span>' + escapeHtml(r.desc) + '</span></div>'
        + '<i data-lucide="chevron-right" class="prot-chevron"></i></li>';
    }).join('');
  }

  // Overall status card
  const overallBadge = document.getElementById('prot-overall-badge');
  if (overallBadge) { overallBadge.textContent = sl.text; overallBadge.className = 'prot-badge ' + sl.cls; }
  setText('prot-overall-sub', score >= 80
    ? "You're well protected, but there's room for improvement."
    : score >= 55
      ? 'Solid start — close remaining coverage gaps.'
      : 'Add more protection policies to strengthen your safety net.');
  setText('prot-gauge-score', String(score));
  const stats = document.getElementById('prot-overall-stats');
  if (stats) {
    stats.innerHTML =
      '<li><i data-lucide="umbrella"></i> Coverage: <strong>' + coveredCount + '/' + totalTypes + '</strong></li>'
      + '<li><i data-lucide="wallet"></i> Emergency Fund: <strong>' + escapeHtml(ef.text) + '</strong></li>'
      + '<li><i data-lucide="coins"></i> Monthly Cost: <strong>' + peso(monthlyCost) + '</strong></li>';
  }

  // Policies table
  const body = document.getElementById('protection-table-body');
  if (body) {
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="text-center text-[var(--ft-muted)] py-6">No protection policies yet</td></tr>';
    } else {
      body.innerHTML = rows.slice().sort(function (a, b) {
        return String(b.date || '').localeCompare(String(a.date || ''));
      }).map(function (i) {
        const type = normalizeProtType(i.policyType);
        const meta = PROT_TYPES.find(function (x) { return x.key === type; }) || PROT_TYPES[3];
        return '<tr>'
          + '<td><span class="prot-policy-cell"><span class="prot-policy-ico" style="background:' + meta.color + '22;color:' + meta.color + '"><i data-lucide="' + meta.icon + '"></i></span>'
          + '<strong>' + escapeHtml(i.desc) + '</strong></span></td>'
          + '<td>' + escapeHtml(type) + '</td>'
          + '<td>' + escapeHtml(i.date || '') + '</td>'
          + '<td class="font-bold">' + peso(i.amount) + '</td>'
          + '<td>' + peso(i.monthly || 0) + '</td>'
          + '<td><span class="prot-status-tag ok">Active</span></td>'
          + '<td><div class="prot-row-actions">'
          + '<button type="button" title="Edit" onclick="openProtectionModal(' + i.id + ')"><i data-lucide="pencil"></i></button>'
          + '<button type="button" title="Delete" onclick="openProtectionDeleteModal(' + i.id + ')"><i data-lucide="trash-2"></i></button>'
          + '</div></td></tr>';
      }).join('');
    }
  }

  // Trend chart
  const range = state.protTrendRange || 12;
  document.querySelectorAll('#prot-trend-range .prot-range-btn').forEach(function (btn) {
    btn.classList.toggle('active', String(btn.getAttribute('data-range')) === String(range));
  });
  const n = range === 'all' ? 18 : Number(range) || 12;
  const labels = [];
  const values = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    const progress = (n - 1 - i) / Math.max(1, n - 1);
    const base = Math.max(20, score - 25);
    values.push(Math.round(Math.min(100, base + (score - base) * progress + ((i % 3) - 1) * 2)));
  }
  if (values.length) values[values.length - 1] = score;

  destroyChart('protTrend');
  ensureChart('protTrend', 'protTrendChart', {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Score',
        data: values,
        borderColor: '#A8B58A',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.4,
        fill: true,
        backgroundColor: function (ctx) {
          return chartAreaGradient(ctx, 'rgba(168, 181, 138, 0.35)', 'rgba(168, 181, 138, 0.02)');
        }
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (ctx) { return ctx.parsed.y + '/100'; }
          }
        }
      },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 100, ticks: { color: chartTickColor(), stepSize: 25 }, grid: { color: chartGridColor() } }
      }
    })
  });

  // Gauge doughnut
  destroyChart('protGauge');
  ensureChart('protGauge', 'protGaugeChart', {
    type: 'doughnut',
    data: {
      labels: ['Score', 'Remain'],
      datasets: [{
        data: [score, Math.max(0, 100 - score)],
        backgroundColor: ['#B46A72', 'rgba(180,106,114,0.12)'],
        borderWidth: 0,
        hoverOffset: 0
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      cutout: '78%',
      rotation: -90,
      circumference: 180,
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    })
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setProtTrendRange(range) {
  state.protTrendRange = range;
  renderProtectionPage();
}

let pendingProtectionDeleteId = null;

function openProtectionModal(editId, presetType) {
  const modal = document.getElementById('protection-modal');
  if (!modal) return;
  const item = editId != null
    ? state.protection.find(function (i) { return String(i.id) === String(editId); })
    : null;
  document.getElementById('protection-modal-edit-id').value = item ? String(item.id) : '';
  document.getElementById('protection-modal-title').textContent = item ? 'Edit Protection' : 'Add Protection';
  document.getElementById('protection-modal-subtitle').textContent = item
    ? 'Update this policy or coverage.'
    : 'Log a policy or update existing coverage.';
  document.getElementById('protection-modal-save-label').textContent = item ? 'Update Protection' : 'Save Protection';
  document.getElementById('protection-modal-desc').value = item ? item.desc : '';
  document.getElementById('protection-modal-amount').value = item ? item.amount : '';
  document.getElementById('protection-modal-monthly').value = item && item.monthly ? item.monthly : '';
  document.getElementById('protection-modal-type').value = item
    ? normalizeProtType(item.policyType)
    : (presetType ? normalizeProtType(presetType) : 'Health Insurance');
  document.getElementById('protection-modal-date').value = item ? (toDateInputValue(item.date) || todayISO()) : todayISO();
  modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeProtectionModal() {
  const modal = document.getElementById('protection-modal');
  if (modal) modal.style.display = 'none';
}

function submitProtectionModal(e) {
  e.preventDefault();
  const desc = document.getElementById('protection-modal-desc').value.trim();
  const amount = parseFloat(document.getElementById('protection-modal-amount').value);
  const monthly = parseFloat(document.getElementById('protection-modal-monthly').value) || 0;
  const policyType = normalizeProtType(document.getElementById('protection-modal-type').value);
  const date = toDateInputValue(document.getElementById('protection-modal-date').value) || todayISO();
  if (!desc || !(amount >= 0) || Number.isNaN(amount)) {
    showToast('Enter a valid policy and coverage amount', 'rose');
    return;
  }
  const editId = document.getElementById('protection-modal-edit-id').value;
  const payload = { desc: desc, amount: amount, monthly: monthly, policyType: policyType, date: date };
  clearSampleFlagIfNeeded();
  if (editId) {
    const idx = state.protection.findIndex(function (i) { return String(i.id) === String(editId); });
    if (idx >= 0) state.protection[idx] = Object.assign({}, state.protection[idx], payload);
    showToast('Protection updated!', 'success');
  } else {
    state.protection.push(Object.assign({ id: Date.now() }, payload));
    showToast('Protection saved!', 'success');
    fireConfetti();
    triggerCardPulse('card-protection');
  }
  closeProtectionModal();
  saveUserData();
  renderApp();
  checkAchievements();
}

function openProtectionDeleteModal(id) {
  pendingProtectionDeleteId = id;
  const item = state.protection.find(function (i) { return String(i.id) === String(id); });
  const msg = document.getElementById('protection-delete-message');
  if (msg) {
    msg.textContent = item
      ? 'Delete “' + item.desc + '”? This updates your protection score.'
      : 'Are you sure you want to delete this policy?';
  }
  const modal = document.getElementById('protection-delete-modal');
  if (modal) modal.style.display = 'flex';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeProtectionDeleteModal() {
  pendingProtectionDeleteId = null;
  const modal = document.getElementById('protection-delete-modal');
  if (modal) modal.style.display = 'none';
}

function confirmProtectionDelete() {
  if (pendingProtectionDeleteId == null) return;
  const id = pendingProtectionDeleteId;
  closeProtectionDeleteModal();
  clearSampleFlagIfNeeded();
  state.protection = state.protection.filter(function (i) { return String(i.id) !== String(id); });
  saveUserData();
  showToast('Protection deleted', 'success');
  renderApp();
}

/** @deprecated use renderProtectionPage */
function renderProtectionPanel() {
  renderProtectionPage();
}

function filterByCalcPeriod(arr, period) {
  const now = new Date();
  if (period === 'all') return (arr || []).slice();
  return (arr || []).filter(function (item) {
    if (!item || !item.date) return true;
    const d = new Date(item.date);
    if (Number.isNaN(d.getTime())) return true;
    if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return d.getFullYear() === now.getFullYear();
  });
}

function focusCalculatorCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('calc-card-pulse');
  void el.offsetWidth;
  el.classList.add('calc-card-pulse');
  setTimeout(function () { el.classList.remove('calc-card-pulse'); }, 1200);
}

function renderCalculator() {
  const wrap = document.getElementById('calculator-cards');
  if (!wrap) return;

  const period = ((document.getElementById('calc-period') || {}).value || 'year');
  const income = sum(filterByCalcPeriod(state.income, period));
  const spending = sum(filterByCalcPeriod(state.expenses, period));
  const savings = sum(filterByCalcPeriod(state.savings, period));
  const tAll = totals();
  const p = pillarScores();
  const hs = healthScore();

  // Exact formulas from Calculator spec (image 3)
  const savingsRate = income > 0 ? (savings / income) * 100 : 0;
  const spendingRatio = income > 0 ? (spending / income) * 100 : 0;
  const disposable = income - spending;
  const ef = tAll.ef;
  const essentialMonthly = spending > 0 ? spending : (tAll.spending || 0);
  const efMonths = essentialMonthly > 0 ? ef / essentialMonthly : (ef > 0 ? 99 : 0);

  function explainSavings(rate) {
    if (!(income > 0)) return 'Add income and savings to see what percent of income you save.';
    return 'You saved ' + rate.toFixed(1) + '% of your income.';
  }
  function explainSpending(ratio) {
    if (!(income > 0)) return 'Add income and spending to see what percentage of income is being spent.';
    return 'Shows what percentage of income is being spent — currently ' + ratio.toFixed(1) + '%.';
  }
  function explainDisposable(amt) {
    if (!(income > 0) && !(spending > 0)) return 'Add income and expenses to see how much money remains after expenses.';
    if (amt >= 0) return 'Shows how much money remains after expenses — you have ' + peso(amt) + ' left.';
    return 'Shows how much money remains after expenses — you are short by ' + peso(Math.abs(amt)) + '.';
  }
  function explainEf(months) {
    if (!(ef > 0)) return 'Shows approximately how many months your emergency savings could cover. Start an emergency fund to begin.';
    if (months >= 99) return 'Shows approximately how many months your emergency savings could cover — coverage looks very strong.';
    return 'Shows approximately how many months your emergency savings could cover — about ' + months.toFixed(1) + ' months.';
  }
  function explainScore(score) {
    if (!hasFinancialData()) return 'Gives your overall Financial Health Score once you add financial data.';
    return 'Gives your overall Financial Health Score — currently ' + score + '/100.';
  }

  const cards = [
    {
      id: 'calc-savings-rate',
      accent: 'sage',
      icon: 'piggy-bank',
      title: 'Savings Rate',
      desc: 'How much of your income you save.',
      formula: 'Savings ÷ Income × 100',
      example: peso(savings) + ' ÷ ' + peso(income || 0) + ' × 100 = ' + savingsRate.toFixed(1) + '%',
      result: savingsRate.toFixed(1) + '%',
      resultSub: 'Your savings rate',
      explain: explainSavings(savingsRate)
    },
    {
      id: 'calc-spending-ratio',
      accent: 'rose',
      icon: 'shopping-cart',
      title: 'Spending Ratio',
      desc: 'Share of income that goes to spending.',
      formula: 'Spending ÷ Income × 100',
      example: peso(spending) + ' ÷ ' + peso(income || 0) + ' × 100 = ' + spendingRatio.toFixed(1) + '%',
      result: spendingRatio.toFixed(1) + '%',
      resultSub: 'Your spending ratio',
      explain: explainSpending(spendingRatio)
    },
    {
      id: 'calc-disposable',
      accent: 'mist',
      icon: 'banknote',
      title: 'Disposable Income',
      desc: 'Money left after expenses.',
      formula: 'Income − Expenses',
      example: peso(income) + ' − ' + peso(spending) + ' = ' + peso(disposable),
      result: peso(disposable),
      resultSub: 'Your disposable income',
      explain: explainDisposable(disposable)
    },
    {
      id: 'calc-ef',
      accent: 'orange',
      icon: 'shield-check',
      title: 'Emergency Fund Coverage',
      desc: 'Months your EF can cover.',
      formula: 'Emergency Savings ÷ Essential Monthly Expenses',
      example: peso(ef) + ' ÷ ' + peso(essentialMonthly || 0) + ' = ' + (efMonths >= 99 ? '∞' : efMonths.toFixed(1)) + ' months',
      result: (efMonths >= 99 ? '∞' : efMonths.toFixed(1)) + ' months',
      resultSub: efMonths >= 1 && efMonths < 99
        ? ('You can cover ' + efMonths.toFixed(1) + ' months of expenses')
        : 'Emergency fund coverage',
      explain: explainEf(efMonths)
    },
    {
      id: 'calc-score',
      accent: 'purple',
      icon: 'star',
      title: 'Score Calculation',
      desc: 'Overall financial health score.',
      formula: '(Income Score + Savings Score + Spending Score + Investment Score + Protection Score) ÷ 5',
      example: '(' + p.income + ' + ' + p.savings + ' + ' + p.spending + ' + ' + p.investment + ' + ' + p.protection + ') ÷ 5 = ' + hs,
      result: hs + '/100',
      resultSub: 'Your financial health score',
      explain: explainScore(hs)
    }
  ];

  const guide = {
    id: 'calc-guide',
    items: cards.map(function (c) {
      return { id: c.id, icon: c.icon, accent: c.accent, title: c.title, formula: c.formula };
    })
  };

  wrap.innerHTML = cards.map(function (c) {
    return '<article class="calc-card is-' + c.accent + '" id="' + c.id + '">'
      + '<div class="calc-card-head">'
      + '<span class="calc-card-ico"><i data-lucide="' + c.icon + '"></i></span>'
      + '<div><h3>' + escapeHtml(c.title) + '</h3><p>' + escapeHtml(c.desc) + '</p></div>'
      + '</div>'
      + '<p class="calc-label">Formula</p>'
      + '<div class="calc-formula-box">' + escapeHtml(c.formula) + '</div>'
      + '<p class="calc-label">Example</p>'
      + '<p class="calc-example">' + escapeHtml(c.example) + '</p>'
      + '<div class="calc-result-box">'
      + '<strong>' + escapeHtml(c.result) + '</strong>'
      + '<span>' + escapeHtml(c.resultSub) + '</span>'
      + '</div>'
      + '<div class="calc-explain"><i data-lucide="lightbulb"></i><span>' + escapeHtml(c.explain) + '</span></div>'
      + '<button type="button" class="calc-recalc-btn" onclick="renderCalculator()"><i data-lucide="refresh-cw"></i> Recalculate</button>'
      + '</article>';
  }).join('')
  + '<aside class="calc-guide-card" id="' + guide.id + '">'
  + '<div class="calc-card-head">'
  + '<span class="calc-card-ico is-guide"><i data-lucide="book-open"></i></span>'
  + '<div><h3>Quick Guide</h3><p>All formulas at a glance.</p></div>'
  + '</div>'
  + '<ul class="calc-guide-list">'
  + guide.items.map(function (item) {
    return '<li class="is-' + item.accent + '" onclick="focusCalculatorCard(\'' + item.id + '\')">'
      + '<span class="calc-guide-ico"><i data-lucide="' + item.icon + '"></i></span>'
      + '<div><strong>' + escapeHtml(item.title) + '</strong><span>' + escapeHtml(item.formula) + '</span></div>'
      + '<i data-lucide="chevron-right" class="calc-guide-arrow"></i></li>';
  }).join('')
  + '</ul></aside>';

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

/* ---------- Charts ---------- */
function chartDefaults() {
  const dark = document.body.getAttribute('data-mode') === 'dark';
  const tick = dark ? '#e8eef2' : '#6b7785';
  const grid = dark ? 'rgba(247, 241, 224, 0.1)' : 'rgba(45,58,71,0.08)';
  const legend = dark ? '#F7F1E0' : '#3D4D57';
  return {
    responsive: true,
    maintainAspectRatio: false,
    color: legend,
    plugins: { legend: { labels: { color: legend, font: { size: 10 } } } },
    scales: {
      x: { ticks: { color: tick, font: { size: 10 } }, grid: { color: grid } },
      y: { ticks: { color: tick }, grid: { color: grid }, beginAtZero: true }
    }
  };
}

function chartTickColor() {
  return document.body.getAttribute('data-mode') === 'dark' ? '#e8eef2' : '#6b7785';
}

function chartGridColor() {
  return document.body.getAttribute('data-mode') === 'dark' ? 'rgba(247, 241, 224, 0.1)' : 'rgba(45,58,71,0.08)';
}

function chartLabelColor() {
  return document.body.getAttribute('data-mode') === 'dark' ? '#c5d4b5' : '#4f6140';
}

function softColors() {
  return ['#B46A72', '#A8B58A', '#A9B7C6', '#F7C8D3', '#2D3A47', '#7f8c64', '#d48a98'];
}

function allocationRingData() {
  const t = totals();
  // Protection coverage ₱ is insurance face value — not comparable to income/spend.
  // Use monthly premiums so the rings stay meaningful.
  const protMonthly = (state.protection || []).reduce(function (a, p) {
    return a + (Number(p.monthly) || 0);
  }, 0);
  const primary = (getComputedStyle(document.body).getPropertyValue('--theme-primary') || '').trim() || '#B46A72';
  const rings = [
    { label: 'Income', color: primary, amount: t.income },
    { label: 'Savings', color: '#A8B58A', amount: t.savings },
    { label: 'Spending', color: '#A9B7C6', amount: t.spending },
    { label: 'Investment', color: '#F7C8D3', amount: t.investments },
    { label: 'Protection', color: '#2D3A47', amount: protMonthly }
  ];
  if (!hasFinancialData()) {
    return rings.map(function (r) { return Object.assign({}, r, { pct: 0 }); });
  }
  // Scale each ring vs the largest cash bucket (progress arcs, not a pie)
  const peak = Math.max.apply(null, rings.map(function (r) { return Number(r.amount) || 0; }).concat([1]));
  return rings.map(function (r) {
    return Object.assign({}, r, {
      pct: Math.max(0, Math.min(100, Math.round((Number(r.amount) / peak) * 100)))
    });
  });
}

function renderAllocationLegend(rings) {
  const el = document.getElementById('allocation-legend');
  if (!el) return;
  const order = ['Income', 'Savings', 'Spending', 'Investment', 'Protection'];
  const byLabel = {};
  rings.forEach(function (r) { byLabel[r.label] = r; });
  el.innerHTML = order.map(function (label) {
    const r = byLabel[label];
    if (!r) return '';
    const ringIndex = rings.findIndex(function (x) { return x.label === label; });
    const tip = label === 'Protection'
      ? 'Monthly protection cost'
      : 'Amount vs largest bucket';
    return '<li data-ring="' + ringIndex + '" tabindex="0" title="' + tip + '">'
      + '<span class="swatch" style="background:' + r.color + '"></span>'
      + '<span class="name">' + r.label + '</span>'
      + '<em class="dash-alloc-pct">' + r.pct + '%</em></li>';
  }).join('');
}

let _allocHoverIndex = -1;
let _allocHitMap = [];
let _allocPointerBound = false;

/** Clean Apple-Watch-style concentric progress rings (custom canvas). */
function drawAllocationRadial(rings, hoverIndex) {
  const canvas = document.getElementById('allocationChart');
  if (!canvas) return;
  if (typeof hoverIndex !== 'number') hoverIndex = _allocHoverIndex;
  const dpr = window.devicePixelRatio || 1;
  const cssSize = Math.max(180, Math.round(canvas.clientWidth || 240));
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const cx = cssSize / 2;
  const cy = cssSize / 2;
  const stroke = Math.max(9, Math.min(12, cssSize * 0.042));
  const gap = stroke * 0.72;
  const outerR = cssSize / 2 - stroke / 2 - 14;
  const trackColor = 'rgba(45, 58, 71, 0.1)';
  _allocHitMap = [];

  ctx.lineCap = 'round';
  ctx.lineWidth = stroke;

  rings.forEach(function (ring, i) {
    const radius = outerR - i * (stroke + gap);
    if (radius < stroke * 1.2) return;
    const pct = Math.max(0, Math.min(100, Number(ring.pct) || 0));
    const start = -Math.PI / 2;
    const sweep = (Math.PI * 2 * pct) / 100;
    const isHover = hoverIndex === i;
    const activeStroke = isHover ? stroke + 1.5 : stroke;

    _allocHitMap.push({
      index: i,
      radius: radius,
      half: (stroke + gap * 0.35) / 2,
      label: ring.label,
      pct: pct,
      color: ring.color
    });

    ctx.lineWidth = stroke;
    ctx.beginPath();
    ctx.strokeStyle = trackColor;
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (pct > 0.5) {
      ctx.lineWidth = activeStroke;
      ctx.beginPath();
      ctx.strokeStyle = ring.color;
      if (pct >= 99.5) ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      else ctx.arc(cx, cy, radius, start, start + sweep);
      ctx.stroke();
    }
  });

  // Center: one percentage only (on hover), colored by active ring
  if (hoverIndex >= 0 && rings[hoverIndex]) {
    const r = rings[hoverIndex];
    const pctText = r.pct + '%';
    // Fit inside innermost ring hole with comfortable padding
    const innerHole = Math.max(28, outerR - (rings.length - 1) * (stroke + gap) - stroke);
    const fontSize = Math.max(14, Math.min(22, Math.round(innerHole * 0.42)));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = r.color || '#2D3A47';
    ctx.font = '800 ' + fontSize + 'px Nunito, system-ui, sans-serif';
    ctx.fillText(pctText, cx, cy);
    ctx.restore();
  }

  syncAllocationLegendHover(hoverIndex);
}

function syncAllocationLegendHover(hoverIndex) {
  const el = document.getElementById('allocation-legend');
  if (!el) return;
  el.querySelectorAll('li').forEach(function (li) {
    const idx = Number(li.getAttribute('data-ring'));
    li.classList.toggle('is-hot', idx === hoverIndex);
  });
}

function hitTestAllocationRing(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const cssSize = canvas.clientWidth || 240;
  const cx = cssSize / 2;
  const cy = cssSize / 2;
  const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
  let found = -1;
  for (let i = _allocHitMap.length - 1; i >= 0; i--) {
    const h = _allocHitMap[i];
    if (Math.abs(dist - h.radius) <= h.half) {
      found = h.index;
      break;
    }
  }
  return found;
}

function setAllocationHover(index) {
  if (_allocHoverIndex === index) return;
  _allocHoverIndex = index;
  const canvas = document.getElementById('allocationChart');
  if (canvas) canvas.style.cursor = index >= 0 ? 'pointer' : 'default';
  drawAllocationRadial(allocationRingData(), index);
}

function bindAllocationPointer() {
  if (_allocPointerBound) return;
  _allocPointerBound = true;
  const canvas = document.getElementById('allocationChart');
  const legend = document.getElementById('allocation-legend');
  if (canvas) {
    canvas.addEventListener('mousemove', function (e) {
      setAllocationHover(hitTestAllocationRing(canvas, e.clientX, e.clientY));
    });
    canvas.addEventListener('mouseleave', function () {
      setAllocationHover(-1);
    });
  }
  if (legend) {
    legend.addEventListener('mouseover', function (e) {
      const li = e.target.closest('li[data-ring]');
      if (!li) return;
      setAllocationHover(Number(li.getAttribute('data-ring')));
    });
    legend.addEventListener('mouseleave', function () {
      setAllocationHover(-1);
    });
    legend.addEventListener('focusin', function (e) {
      const li = e.target.closest('li[data-ring]');
      if (!li) return;
      setAllocationHover(Number(li.getAttribute('data-ring')));
    });
    legend.addEventListener('focusout', function () {
      setAllocationHover(-1);
    });
  }
}

function renderAllocationChart() {
  const rings = allocationRingData();
  renderAllocationLegend(rings);
  destroyChart('allocation');
  _allocHoverIndex = -1;
  drawAllocationRadial(rings, -1);
  bindAllocationPointer();
}

let _allocResizeBound = false;
function bindAllocationResize() {
  if (_allocResizeBound) return;
  _allocResizeBound = true;
  let timer = null;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (document.getElementById('allocationChart')) {
        drawAllocationRadial(allocationRingData(), _allocHoverIndex);
      }
    }, 120);
  });
}

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function ensureChart(key, canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  if (charts[key]) {
    const prevType = charts[key].config && (charts[key].config.type || (charts[key].config._config && charts[key].config._config.type));
    if (prevType && config.type && prevType !== config.type) {
      destroyChart(key);
    } else {
      charts[key].data = config.data;
      if (config.options) charts[key].options = config.options;
      charts[key].update();
      return charts[key];
    }
  }
  charts[key] = new Chart(canvas, config);
  return charts[key];
}

function initCharts() {
  updateCharts();
}

function filterByAnalyticsPeriod(arr, period) {
  const now = new Date();
  if (period === 'all') return (arr || []).slice();
  return (arr || []).filter(function (item) {
    if (!item || !item.date) return true;
    const d = new Date(item.date);
    if (Number.isNaN(d.getTime())) return true;
    if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return d.getFullYear() === now.getFullYear();
  });
}

function expensesInAnRange(list, rangeVal) {
  const now = new Date();
  if (rangeVal === 'all') return list.slice();
  if (rangeVal === 'prev') {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return list.filter(function (e) {
      if (!e.date) return false;
      const d = new Date(e.date);
      return d.getFullYear() === prev.getFullYear() && d.getMonth() === prev.getMonth();
    });
  }
  return list.filter(function (e) {
    if (!e.date) return false;
    const d = new Date(e.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}

function renderAnalyticsPage() {
  if (!document.getElementById('view-analytics')) return;
  const t = totals();
  const period = ((document.getElementById('analytics-period') || {}).value || 'year');
  const spendRange = ((document.getElementById('an-spend-range') || {}).value || 'month');
  const monthMetric = ((document.getElementById('an-month-metric') || {}).value || 'expenses');
  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth();

  const incomeArr = filterByAnalyticsPeriod(state.income, period);
  const expenseArr = filterByAnalyticsPeriod(state.expenses, period);
  const savingsArr = filterByAnalyticsPeriod(state.savings, period);
  const incomeTotal = sum(incomeArr);
  const spendTotal = sum(expenseArr);
  const saveTotal = sum(savingsArr);
  const netWorth = Math.max(0, t.savings + t.investments);

  const spendMom = monthOverMonthPct(state.expenses);
  const saveMom = monthOverMonthPct(state.savings);
  const incomeMom = monthOverMonthPct(state.income);

  function setTrend(id, pct, invertGood) {
    const el = document.getElementById(id);
    if (!el) return;
    const abs = Math.abs(pct);
    const good = invertGood ? pct < 0 : pct > 0;
    if (pct === 0) {
      el.textContent = '— 0% vs. last month';
      el.className = 'an-metric-trend';
      return;
    }
    if (pct > 0) {
      el.textContent = '↑ +' + abs + '% vs. last month';
      el.className = 'an-metric-trend ' + (good ? 'is-up' : 'is-down');
    } else {
      el.textContent = '↓ ' + abs + '% vs. last month';
      el.className = 'an-metric-trend ' + (good ? 'is-up' : 'is-down');
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  setText('an-spend', peso(spendTotal));
  setText('an-save', peso(saveTotal));
  setText('an-income', peso(incomeTotal));
  setText('an-networth', peso(netWorth));
  setTrend('an-spend-trend', spendMom, true);
  setTrend('an-save-trend', saveMom, false);
  setTrend('an-income-trend', incomeMom, false);
  const nwTrend = document.getElementById('an-networth-trend');
  if (nwTrend) {
    if (!hasFinancialData()) {
      nwTrend.textContent = 'add data to track';
      nwTrend.className = 'an-metric-trend';
    } else if (saveMom === 0) {
      nwTrend.textContent = 'stable vs. last month';
      nwTrend.className = 'an-metric-trend';
    } else if (saveMom > 0) {
      nwTrend.textContent = '↑ +' + Math.abs(saveMom) + '% vs. last month';
      nwTrend.className = 'an-metric-trend is-up';
    } else {
      nwTrend.textContent = '↓ ' + Math.abs(saveMom) + '% vs. last month';
      nwTrend.className = 'an-metric-trend is-down';
    }
  }

  const spendSlice = expensesInAnRange(state.expenses, spendRange);
  const catOrder = SPEND_CAT_ORDER.slice();
  const catMap = {};
  catOrder.forEach(function (k) { catMap[k] = 0; });
  spendSlice.forEach(function (e) {
    const c = normalizeSpendCat(e.category || 'Other Expenses');
    catMap[c] = (catMap[c] || 0) + Number(e.amount || 0);
  });
  const donutTotal = Object.keys(catMap).reduce(function (a, k) { return a + catMap[k]; }, 0);
  const activeDonut = catOrder.filter(function (k) { return catMap[k] > 0; });

  setText('an-donut-total', peso(donutTotal).replace(/\.00$/, ''));
  const legend = document.getElementById('an-spend-legend');
  if (legend) {
    legend.innerHTML = catOrder.map(function (k) {
      const amt = catMap[k] || 0;
      const pct = donutTotal > 0 ? Math.round((amt / donutTotal) * 100) : 0;
      const meta = SPEND_CAT_META[k] || SPEND_CAT_META['Other Expenses'];
      const label = k === 'Food' ? 'Food' : (k === 'Transportation' ? 'Transportation' : meta.label);
      return '<li' + (amt <= 0 ? ' class="is-empty"' : '') + '>'
        + '<span class="dot" style="background:' + meta.color + '"></span>'
        + '<span class="name">' + escapeHtml(label) + ' (' + pct + '%)</span>'
        + '<span class="meta">' + peso(amt) + '</span></li>';
    }).join('');
  }

  destroyChart('anSpendDonut');
  ensureChart('anSpendDonut', 'anSpendDonutChart', {
    type: 'doughnut',
    data: {
      labels: activeDonut.length ? activeDonut : ['No data'],
      datasets: [{
        data: activeDonut.length ? activeDonut.map(function (k) { return catMap[k]; }) : [1],
        backgroundColor: activeDonut.length ? activeDonut.map(function (k) { return (SPEND_CAT_META[k] || SPEND_CAT_META['Other Expenses']).color; }) : ['#e5e7eb'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: { enabled: activeDonut.length > 0 } }
    })
  });

  const monthsCount = 12;
  const trendLabels = [];
  const incomeSeries = [];
  const expenseSeries = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(cy, cm - i, 1);
    trendLabels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
    incomeSeries.push(sumInCalendarMonth(state.income, d.getFullYear(), d.getMonth()));
    expenseSeries.push(sumInCalendarMonth(state.expenses, d.getFullYear(), d.getMonth()));
  }
  destroyChart('anIncomeExpense');
  ensureChart('anIncomeExpense', 'anIncomeExpenseChart', {
    type: 'line',
    data: {
      labels: trendLabels,
      datasets: [
        {
          label: 'Income',
          data: incomeSeries,
          borderColor: '#A8B58A',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.35,
          fill: false
        },
        {
          label: 'Expenses',
          data: expenseSeries,
          borderColor: '#B46A72',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.35,
          fill: false
        }
      ]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: {
        legend: { display: true, labels: { boxWidth: 10, font: { size: 10 }, color: chartTickColor() } },
        tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': ' + peso(ctx.parsed.y); } } }
      },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });

  const insights = document.getElementById('an-insights');
  if (insights) {
    const tips = [];
    let topCat = null;
    Object.keys(catMap).forEach(function (k) {
      if (!topCat || catMap[k] > catMap[topCat]) topCat = k;
    });
    if (topCat && catMap[topCat] > 0) {
      const meta = SPEND_CAT_META[topCat] || SPEND_CAT_META['Other Expenses'];
      const pct = donutTotal > 0 ? Math.round((catMap[topCat] / donutTotal) * 100) : 0;
      const label = topCat === 'Food' ? 'Food' : meta.label;
      tips.push({ icon: meta.icon, color: meta.color, text: 'Your highest spending category is ' + label + ' (' + pct + '%).' });
    }
    if (spendMom < 0) tips.push({ icon: 'trending-down', color: '#A8B58A', text: 'Spending is down ' + Math.abs(spendMom) + '% vs last month — nice control.' });
    else if (spendMom > 0) tips.push({ icon: 'trending-up', color: '#B46A72', text: 'Spending rose ' + spendMom + '% vs last month — review wants.' });
    else tips.push({ icon: 'activity', color: '#A9B7C6', text: 'Spending is flat vs last month.' });
    if (t.income > 0 && t.spending > 0) tips.push({ icon: 'percent', color: '#7f9bb8', text: 'Expenses are ' + Math.round((t.spending / t.income) * 100) + '% of total income.' });
    if (t.savingsRate >= 20) tips.push({ icon: 'piggy-bank', color: '#A8B58A', text: 'Savings rate is ' + t.savingsRate.toFixed(1) + '% — keep the streak.' });
    else tips.push({ icon: 'sparkles', color: '#B46A72', text: 'Try pushing savings toward a 20%+ rate of income.' });
    if (saveMom > 0) tips.push({ icon: 'check', color: '#A8B58A', text: 'Savings grew ' + saveMom + '% vs last month.' });
    insights.innerHTML = tips.slice(0, 5).map(function (tip) {
      return '<li><span class="an-insight-ico" style="background:' + tip.color + '22;color:' + tip.color + '"><i data-lucide="' + tip.icon + '"></i></span>'
        + '<span>' + escapeHtml(tip.text) + '</span>'
        + '<i data-lucide="chevron-right" class="an-chevron"></i></li>';
    }).join('') || '<li class="an-insight-empty">Add spending data to unlock insights.</li>';
  }

  const thisMonthExp = expensesInAnRange(state.expenses, 'month');
  const lastMonthExp = expensesInAnRange(state.expenses, 'prev');
  const thisMap = {};
  const lastMap = {};
  catOrder.forEach(function (k) { thisMap[k] = 0; lastMap[k] = 0; });
  thisMonthExp.forEach(function (e) {
    const c = normalizeSpendCat(e.category || 'Other Expenses');
    thisMap[c] = (thisMap[c] || 0) + Number(e.amount || 0);
  });
  lastMonthExp.forEach(function (e) {
    const c = normalizeSpendCat(e.category || 'Other Expenses');
    lastMap[c] = (lastMap[c] || 0) + Number(e.amount || 0);
  });
  const shortCats = catOrder.map(function (k) {
    const shorts = {
      Transportation: 'Transport',
      'Bills & Utilities': 'Bills',
      Healthcare: 'Health',
      Education: 'Educ',
      Shopping: 'Shop',
      Entertainment: 'Fun',
      'Debt Payments': 'Debt',
      'Donations & Charity': 'Charity',
      Emergency: 'Emerg',
      'Other Expenses': 'Other'
    };
    return shorts[k] || k;
  });
  destroyChart('anCatCompare');
  ensureChart('anCatCompare', 'anCatCompareChart', {
    type: 'bar',
    data: {
      labels: shortCats,
      datasets: [
        { label: 'This Month', data: catOrder.map(function (k) { return thisMap[k]; }), backgroundColor: '#B46A72', borderRadius: 6 },
        { label: 'Last Month', data: catOrder.map(function (k) { return lastMap[k]; }), backgroundColor: '#F7C8D3', borderRadius: 6 }
      ]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 }, color: chartTickColor() } } },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });

  const summary = document.getElementById('an-summary-list');
  if (summary) {
    const rows = [
      { label: 'Total Income', icon: 'trending-up', color: '#7f9bb8', amt: t.income, mom: incomeMom },
      { label: 'Total Expenses', icon: 'wallet', color: '#B46A72', amt: t.spending, mom: spendMom, invert: true },
      { label: 'Savings', icon: 'piggy-bank', color: '#A8B58A', amt: t.savings, mom: saveMom },
      { label: 'Net Worth', icon: 'target', color: '#e8a05c', amt: netWorth, mom: saveMom }
    ];
    summary.innerHTML = rows.map(function (r) {
      const abs = Math.abs(r.mom);
      const good = r.invert ? r.mom < 0 : r.mom > 0;
      let momTxt = '— 0%';
      let cls = '';
      if (r.mom > 0) { momTxt = '↑ +' + abs + '%'; cls = good ? 'is-up' : 'is-down'; }
      else if (r.mom < 0) { momTxt = '↓ ' + abs + '%'; cls = good ? 'is-up' : 'is-down'; }
      return '<li>'
        + '<span class="an-sum-ico" style="background:' + r.color + '22;color:' + r.color + '"><i data-lucide="' + r.icon + '"></i></span>'
        + '<div><strong>' + escapeHtml(r.label) + '</strong><em class="' + cls + '">' + momTxt + '</em></div>'
        + '<span class="an-sum-amt">' + peso(r.amt) + '</span></li>';
    }).join('');
  }

  const mLabels = [];
  const mValues = [];
  const sourceArr = monthMetric === 'income' ? state.income : monthMetric === 'savings' ? state.savings : state.expenses;
  for (let i = 5; i >= 0; i--) {
    const d = new Date(cy, cm - i, 1);
    mLabels.push(d.toLocaleDateString('en-US', { month: 'short' }));
    mValues.push(sumInCalendarMonth(sourceArr, d.getFullYear(), d.getMonth()));
  }
  destroyChart('anMonthlyCompare');
  ensureChart('anMonthlyCompare', 'anMonthlyCompareChart', {
    type: 'bar',
    data: {
      labels: mLabels,
      datasets: [{
        label: monthMetric.charAt(0).toUpperCase() + monthMetric.slice(1),
        data: mValues,
        backgroundColor: mValues.map(function (_, idx) { return idx === mValues.length - 1 ? '#B46A72' : '#F7C8D3'; }),
        borderRadius: 8
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function (ctx) { return peso(ctx.parsed.y); } } }
      },
      scales: {
        x: { ticks: { color: chartTickColor(), font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: chartTickColor() }, grid: { color: chartGridColor() }, beginAtZero: true }
      }
    })
  });

  const hs = healthScore();
  const pillars = pillarScores();
  let goalsScore = 15;
  const activeSavGoals = (state.savings || []).filter(function (s) { return !s.isCompleted && Number(s.target) > 0; });
  if (activeSavGoals.length) {
    goalsScore = Math.round(activeSavGoals.reduce(function (a, g) {
      return a + Math.min(100, (Number(g.amount) / Number(g.target)) * 100);
    }, 0) / activeSavGoals.length);
  } else if (t.savings > 0) goalsScore = 40;
  setText('an-health-score', String(hs));
  const healthLabel = document.getElementById('an-health-label');
  if (healthLabel) healthLabel.textContent = '/100 · ' + (hs >= 75 ? 'Good' : hs >= 50 ? 'Fair' : hasFinancialData() ? 'Building' : '—');
  const pillarList = document.getElementById('an-health-pillars');
  if (pillarList) {
    const items = [
      { label: 'Spending', score: pillars.spending, color: '#B46A72' },
      { label: 'Savings', score: pillars.savings, color: '#A8B58A' },
      { label: 'Investment', score: pillars.investment, color: '#F7C8D3' },
      { label: 'Protection', score: pillars.protection, color: '#7f9bb8' },
      { label: 'Goals', score: goalsScore, color: '#e8a05c' }
    ];
    pillarList.innerHTML = items.map(function (it) {
      return '<li><span>' + escapeHtml(it.label) + '</span>'
        + '<div class="an-pillar-track"><div class="an-pillar-fill" style="width:' + it.score + '%;background:' + it.color + '"></div></div>'
        + '<strong>' + it.score + '/100</strong></li>';
    }).join('');
  }
  const tip = document.getElementById('an-health-tip');
  if (tip) {
    const tipSpan = tip.querySelector('span');
    if (tipSpan) {
      if (!hasFinancialData()) tipSpan.textContent = 'Add financial data to unlock your health score.';
      else if (hs >= 75) tipSpan.textContent = "You're on track! Keep it up and aim for an even healthier financial future.";
      else if (hs >= 50) tipSpan.textContent = 'Solid foundation — tighten spending and grow savings for a higher score.';
      else tipSpan.textContent = 'Start with income, spending, and an emergency fund to lift your health score.';
    }
  }
  destroyChart('anHealthGauge');
  ensureChart('anHealthGauge', 'anHealthGaugeChart', {
    type: 'doughnut',
    data: {
      labels: ['Score', 'Remain'],
      datasets: [{
        data: [hs, Math.max(0, 100 - hs)],
        backgroundColor: ['#A8B58A', 'rgba(168,181,138,0.15)'],
        borderWidth: 0,
        hoverOffset: 0
      }]
    },
    options: Object.assign({}, chartDefaults(), {
      cutout: '78%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    })
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function updateCharts() {
  const t = totals();
  const grid = { color: chartGridColor() };
  const ticks = { color: chartTickColor() };

  renderAllocationChart();
  bindAllocationResize();

  ensureChart('growth', 'growthChart', {
    type: 'line',
    data: {
      labels: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'],
      datasets: [
        {
          label: 'Net Worth trend',
          data: buildNetWorthTrend(t),
          borderColor: '#D4A0A8',
          borderWidth: 3,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#B9868C',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          backgroundColor: function (ctx) {
            return chartAreaGradient(ctx, 'rgba(241, 194, 204, 0.45)', 'rgba(241, 194, 204, 0.02)');
          },
          fill: true,
          tension: 0.4
        },
        {
          label: 'Savings trend',
          data: buildSavingsTrend(t),
          borderColor: '#9AAA88',
          borderWidth: 2.5,
          borderDash: [6, 4],
          pointBackgroundColor: '#fff',
          pointBorderColor: '#8a9a78',
          pointBorderWidth: 2,
          pointRadius: 3,
          backgroundColor: function (ctx) {
            return chartAreaGradient(ctx, 'rgba(179, 191, 163, 0.28)', 'rgba(179, 191, 163, 0.02)');
          },
          fill: true,
          tension: 0.4
        }
      ]
    },
    options: Object.assign({}, chartDefaults(), {
      scales: {
        x: { ticks, grid: { display: false } },
        y: {
          ticks,
          grid,
          beginAtZero: true,
          suggestedMin: 0
        }
      }
    })
  });

  // Page-owned chart renderers
  if (state.currentView === 'income') renderIncomePage();
  if (state.currentView === 'spending') renderSpendingPage();
  if (state.currentView === 'savings') renderSavingsPage();
  if (state.currentView === 'investment') renderInvestmentPage();
  if (state.currentView === 'protection') renderProtectionPage();
  if (state.currentView === 'analytics') renderAnalyticsPage();
}

/* ---------- UX helpers ---------- */
function animateNumber(element, target, prefix, suffix, duration) {
  if (!element) return;
  prefix = prefix == null ? '₱' : prefix;
  suffix = suffix || '';
  duration = duration || 700;
  const start = 0;
  const startTime = performance.now();
  const isFloat = true;
  function update(currentTime) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    const current = start + (target - start) * eased;
    element.textContent = prefix + Number(current).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
    if (progress < 1) requestAnimationFrame(update);
    else element.textContent = prefix + Number(target).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix;
  }
  if (prefix === '' && suffix === '%') {
    // percent path used rarely — keep generic
  }
  requestAnimationFrame(update);
}

function fireConfetti() {
  const theme = getStoredTheme();
  const preset = THEME_PRESETS.find(t => t.id === theme) || THEME_PRESETS[0];
  const colors = preset.colors || ['#B46A72', '#F7C8D3', '#A8B58A', '#ABB1C9', '#3D4D57'];
  if (typeof confetti === 'function') {
    confetti({ particleCount: 55, spread: 60, origin: { y: 0.8 }, colors });
  }
}

function triggerCardPulse(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('animate-pulse-glow');
  void card.offsetWidth;
  card.classList.add('animate-pulse-glow');
}

function showToast(message, color) {
  color = color || 'success';
  const container = document.getElementById('toast-container');
  if (!container) { alert(message); return; }
  const toast = document.createElement('div');
  const bg = {
    success: 'bg-white border-[var(--ft-sage)] text-[var(--ft-sage-deep)]',
    info: 'bg-white border-[var(--ft-misty)] text-[var(--ft-lagoon)]',
    rose: 'bg-white border-[var(--ft-rosewood)] text-[var(--ft-rosewood)]'
  };
  toast.className = 'px-4 py-3 rounded-xl border text-xs font-bold shadow-xl flex items-center gap-2 backdrop-blur pointer-events-auto toast-slide-in ' + (bg[color] || bg.success);
  toast.innerHTML = '<i data-lucide="sparkles" class="w-4 h-4"></i> ' + escapeHtml(message);
  container.appendChild(toast);
  lucide.createIcons();
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', function () {
  const registerPass = document.getElementById('register-password');
  const registerConfirm = document.getElementById('register-confirm-password');
  const strength = document.getElementById('register-strength');
  const feedback = document.getElementById('register-feedback');

  function syncPassUI() {
    if (!registerPass || !feedback) return;
    const val = registerPass.value;
    const confirmVal = registerConfirm ? registerConfirm.value : '';
    registerPass.classList.remove('password-match', 'password-mismatch');
    if (registerConfirm) registerConfirm.classList.remove('password-match', 'password-mismatch');
    if (!val) { strength.className = 'password-strength'; feedback.textContent = ''; feedback.className = 'password-feedback'; return; }
    const result = ACCOUNT_SYSTEM.validatePassword(val);
    if (confirmVal) {
      if (val === confirmVal) {
        registerPass.classList.add('password-match');
        registerConfirm.classList.add('password-match');
        strength.className = 'password-strength ' + (result.valid ? 'strong' : 'weak');
        feedback.className = 'password-feedback ' + (result.valid ? 'success' : 'error');
        feedback.textContent = result.valid ? 'Passwords match! Strong password!' : result.message;
      } else {
        registerPass.classList.add('password-mismatch');
        registerConfirm.classList.add('password-mismatch');
        strength.className = 'password-strength weak';
        feedback.className = 'password-feedback error';
        feedback.textContent = 'Passwords do not match!';
      }
    } else {
      strength.className = 'password-strength ' + (result.valid ? 'strong' : 'weak');
      feedback.className = 'password-feedback ' + (result.valid ? 'success' : 'error');
      feedback.textContent = result.valid ? 'Strong password!' : result.message;
    }
  }
  if (registerPass) registerPass.addEventListener('input', syncPassUI);
  if (registerConfirm) registerConfirm.addEventListener('input', syncPassUI);

  applySeasonalAccent();
  const savedTheme = getStoredTheme();
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.body.setAttribute('data-theme', savedTheme);
  setColorMode(getStoredColorMode());
  lucide.createIcons();
  initCharts();

  const currentUser = ACCOUNT_SYSTEM.getCurrentUser();
  if (currentUser) {
    loadUserData(currentUser.username);
    updateUserUI();
    navigateTo('dashboard');
  } else {
    navigateTo('welcome');
  }

  ACCOUNT_SYSTEM.ensureCloudSync().then(async function () {
    const synced = ACCOUNT_SYSTEM.getCurrentUser();
    if (synced) {
      loadUserData(synced.username);
      updateUserUI();
    }
  });

  document.addEventListener('click', function (e) {
    const notifWrap = document.querySelector('.header-notif-wrap');
    if (notifWrap && !notifWrap.contains(e.target)) closeNotificationsDropdown();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeNotificationsDropdown();
      const sidebar = document.getElementById('sidebar');
      if (sidebar && sidebar.classList.contains('active')) toggleSidebar(e);
    }
  });
  window.addEventListener('resize', syncDesktopSidebar);
  initSidebarHoverExpand();
});
