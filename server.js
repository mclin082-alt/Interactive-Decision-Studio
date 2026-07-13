const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const tls = require('tls');const { execFile } = require('child_process');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
loadLocalEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 5173);
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.SLIDE_STUDIO_DATA_DIR || path.join(ROOT, '.local-data'));
const JSON_DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_FILE = path.join(DATA_DIR, 'slide-studio.sqlite');
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
const FRONTEND_SLIDES_DIR = process.env.FRONTEND_SLIDES_DIR || '/Users/lll/.codex/skills/frontend-slides';
const TEMPLATE_DIR = path.join(FRONTEND_SLIDES_DIR, 'beautiful-html-templates', 'templates');
const isProduction = process.env.NODE_ENV === 'production';
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const SMTP_CONFIG = {
  host: String(process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 465),
  user: String(process.env.SMTP_USER || '').trim(),
  pass: String(process.env.SMTP_PASS || '').trim(),
  secure: String(process.env.SMTP_SECURE || 'true') !== 'false'
};
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_CONFIG.user || 'Slide Studio <verify@slidestudio.local>').trim();
const QUOTAS = {
  guestCookieDaily: Number(process.env.GUEST_COOKIE_DAILY_LIMIT || 3),
  guestDeviceDaily: Number(process.env.GUEST_DEVICE_DAILY_LIMIT || 3),
  guestBrowserDaily: Number(process.env.GUEST_BROWSER_DAILY_LIMIT || 3),
  guestIpDaily: Number(process.env.GUEST_IP_DAILY_LIMIT || 5),
  verifiedSignupCredits: Number(process.env.SIGNUP_VERIFIED_CREDITS || 10),
  unverifiedUserDaily: Number(process.env.UNVERIFIED_USER_DAILY_LIMIT || 0),
  freeDailyBudgetCents: Number(process.env.FREE_DAILY_BUDGET_CENTS || 500),
  generationCostCents: Number(process.env.GENERATION_COST_CENTS || 25)
};
const GENERATION_MAX_TOKENS = Number(process.env.GENERATION_MAX_TOKENS || 6500);
const EDIT_MAX_TOKENS = Number(process.env.EDIT_MAX_TOKENS || 9000);
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 120000);
const BASIC_TRIAL_TEMPLATE_IDS = new Set((process.env.BASIC_TRIAL_TEMPLATE_IDS || 'soft-editorial,blue-professional')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean));
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);
let sqliteDb = null;
let isMigratingLegacyDb = false;
const activeGenerationJobs = new Set();

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    process.env[key] = value;
  }
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const db = getSqliteDb();
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      identity_type TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      action TEXT NOT NULL,
      cost_cents INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS signup_verification_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      pending_guest_user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      template_id TEXT,
      template_slug TEXT,
      title TEXT NOT NULL,
      deck_path TEXT,
      file_path TEXT,
      original_html_path TEXT,
      status TEXT NOT NULL,
      current_page INTEGER DEFAULT 1,
      target_context TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      last_applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_messages (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      page INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deck_comments (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      note TEXT NOT NULL,
      x REAL DEFAULT 0,
      y REAL DEFAULT 0,
      selector TEXT,
      element_text TEXT,
      element_tag TEXT,
      element_rect_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deck_versions (
      id TEXT PRIMARY KEY,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      label TEXT,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS template_selections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
      template_id TEXT NOT NULL,
      template_slug TEXT,
      selected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'users', 'email_verified_at', 'TEXT');
  ensureColumn(db, 'users', 'credits', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'users', 'plan', "TEXT DEFAULT 'free'");
  ensureColumn(db, 'users', 'is_guest', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'email_verification_tokens', 'pending_guest_user_id', 'TEXT');
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (!isMigratingLegacyDb && userCount === 0 && fs.existsSync(JSON_DB_FILE)) {
    try {
      isMigratingLegacyDb = true;
      const legacy = JSON.parse(fs.readFileSync(JSON_DB_FILE, 'utf8'));
      writeDb(normalizeDbShape(legacy));
    } catch (error) {
      console.error('[error] Failed to migrate legacy JSON database', error);
    } finally {
      isMigratingLegacyDb = false;
    }
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function getSqliteDb() {
  if (!sqliteDb) sqliteDb = new DatabaseSync(DB_FILE);
  return sqliteDb;
}

function normalizeDbShape(db = {}) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: db.sessions && typeof db.sessions === 'object' ? db.sessions : {},
    decks: Array.isArray(db.decks) ? db.decks : [],
    logs: Array.isArray(db.logs) ? db.logs : [],
    usageEvents: Array.isArray(db.usageEvents) ? db.usageEvents : [],
    verificationTokens: Array.isArray(db.verificationTokens) ? db.verificationTokens : [],
    signupVerificationTokens: Array.isArray(db.signupVerificationTokens) ? db.signupVerificationTokens : []
  };
}

function readDb() {
  ensureDb();
  const db = getSqliteDb();
  const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    emailVerifiedAt: row.email_verified_at || '',
    credits: Number(row.credits || 0),
    plan: row.plan || 'free',
    isGuest: Boolean(row.is_guest)
  }));
  const sessions = Object.fromEntries(db.prepare('SELECT * FROM sessions').all().map((row) => [
    row.token,
    { userId: row.user_id, createdAt: row.created_at }
  ]));
  const decks = db.prepare('SELECT * FROM decks ORDER BY datetime(created_at) DESC').all().map((row) => ({
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    templateId: row.template_id,
    templateSlug: row.template_slug,
    title: row.title,
    deckPath: row.deck_path,
    filePath: row.file_path,
    originalHtmlPath: row.original_html_path,
    status: row.status,
    currentPage: row.current_page || 1,
    targetContext: row.target_context || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastAppliedAt: row.last_applied_at,
    messages: [],
    comments: [],
    versions: []
  }));
  const decksById = new Map(decks.map((deck) => [deck.id, deck]));
  db.prepare('SELECT * FROM deck_messages ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.messages.push({ id: row.id, role: row.role, text: row.text, page: row.page, createdAt: row.created_at });
  });
  db.prepare('SELECT * FROM deck_comments ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.comments.push({
      id: row.id,
      page: row.page,
      note: row.note,
      x: row.x,
      y: row.y,
      selector: row.selector || '',
      elementText: row.element_text || '',
      elementTag: row.element_tag || '',
      elementRect: row.element_rect_json ? JSON.parse(row.element_rect_json) : null,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    });
  });
  db.prepare('SELECT * FROM deck_versions ORDER BY datetime(created_at) ASC').all().forEach((row) => {
    const deck = decksById.get(row.deck_id);
    if (!deck) return;
    deck.versions.push({ id: row.id, label: row.label, filePath: row.file_path, createdAt: row.created_at });
  });
  const logs = db.prepare('SELECT * FROM logs ORDER BY datetime(created_at) DESC LIMIT 200').all().map((row) => ({
    id: row.id,
    level: row.level,
    message: row.message,
    meta: row.meta_json ? JSON.parse(row.meta_json) : {},
    createdAt: row.created_at
  }));
  const usageEvents = db.prepare('SELECT * FROM usage_events ORDER BY datetime(created_at) DESC LIMIT 5000').all().map((row) => ({
    id: row.id,
    userId: row.user_id || '',
    identityType: row.identity_type,
    identityKey: row.identity_key,
    action: row.action,
    costCents: Number(row.cost_cents || 0),
    createdAt: row.created_at
  }));
  const verificationTokens = db.prepare('SELECT * FROM email_verification_tokens ORDER BY datetime(created_at) DESC').all().map((row) => ({
    token: row.token,
    userId: row.user_id,
    pendingGuestUserId: row.pending_guest_user_id || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || ''
  }));
  const signupVerificationTokens = db.prepare('SELECT * FROM signup_verification_tokens ORDER BY datetime(created_at) DESC').all().map((row) => ({
    token: row.token,
    email: row.email,
    name: row.name || '',
    pendingGuestUserId: row.pending_guest_user_id || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || ''
  }));
  return { users, sessions, decks, logs, usageEvents, verificationTokens, signupVerificationTokens };
}

function writeDb(db) {
  ensureDb();
  const data = normalizeDbShape(db);
  const sqlite = getSqliteDb();
  try {
    sqlite.exec('BEGIN');
    sqlite.exec(`
      DELETE FROM logs;
      DELETE FROM usage_events;
      DELETE FROM email_verification_tokens;
      DELETE FROM signup_verification_tokens;
      DELETE FROM template_selections;
      DELETE FROM deck_versions;
      DELETE FROM deck_comments;
      DELETE FROM deck_messages;
      DELETE FROM decks;
      DELETE FROM sessions;
      DELETE FROM users;
    `);
    const insertUser = sqlite.prepare(`INSERT INTO users (
      id, name, email, password_hash, created_at, email_verified_at, credits, plan, is_guest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertSession = sqlite.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
    const insertDeck = sqlite.prepare(`INSERT INTO decks (
      id, user_id, prompt, template_id, template_slug, title, deck_path, file_path, original_html_path, status,
      current_page, target_context, error, created_at, updated_at, completed_at, last_applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMessage = sqlite.prepare('INSERT INTO deck_messages (id, deck_id, role, text, page, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertComment = sqlite.prepare(`INSERT INTO deck_comments (
      id, deck_id, page, note, x, y, selector, element_text, element_tag, element_rect_json, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertVersion = sqlite.prepare('INSERT INTO deck_versions (id, deck_id, label, file_path, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertTemplateSelection = sqlite.prepare('INSERT INTO template_selections (id, user_id, deck_id, template_id, template_slug, selected_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insertLog = sqlite.prepare('INSERT INTO logs (id, level, message, meta_json, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertUsage = sqlite.prepare(`INSERT INTO usage_events (
      id, user_id, identity_type, identity_key, action, cost_cents, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertVerificationToken = sqlite.prepare(`INSERT INTO email_verification_tokens (
      token, user_id, created_at, expires_at, used_at, pending_guest_user_id
    ) VALUES (?, ?, ?, ?, ?, ?)`);
    const insertSignupVerificationToken = sqlite.prepare(`INSERT INTO signup_verification_tokens (
      token, email, name, pending_guest_user_id, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    for (const user of data.users) {
      insertUser.run(
        user.id,
        user.name,
        user.email,
        user.passwordHash,
        user.createdAt || new Date().toISOString(),
        user.emailVerifiedAt || '',
        Number(user.credits || 0),
        user.plan || 'free',
        user.isGuest ? 1 : 0
      );
    }
    for (const [token, session] of Object.entries(data.sessions)) {
      if (data.users.some((user) => user.id === session.userId)) insertSession.run(token, session.userId, session.createdAt || new Date().toISOString());
    }
    for (const deck of data.decks) {
      insertDeck.run(
        deck.id,
        deck.userId,
        deck.prompt || '',
        deck.templateId || '',
        deck.templateSlug || '',
        deck.title || 'Untitled deck',
        deck.deckPath || '',
        deck.filePath || '',
        deck.originalHtmlPath || '',
        deck.status || 'draft',
        Number(deck.currentPage || 1),
        deck.targetContext || '',
        deck.error || '',
        deck.createdAt || new Date().toISOString(),
        deck.updatedAt || deck.createdAt || new Date().toISOString(),
        deck.completedAt || '',
        deck.lastAppliedAt || ''
      );
      if (deck.templateId) {
        insertTemplateSelection.run(
          crypto.randomUUID(),
          deck.userId,
          deck.id,
          deck.templateId,
          deck.templateSlug || '',
          deck.createdAt || new Date().toISOString()
        );
      }
      for (const message of deck.messages || []) {
        insertMessage.run(message.id || crypto.randomUUID(), deck.id, message.role || 'assistant', message.text || '', message.page || null, message.createdAt || new Date().toISOString());
      }
      for (const comment of deck.comments || []) {
        insertComment.run(
          comment.id || crypto.randomUUID(),
          deck.id,
          Number(comment.page || 1),
          comment.note || '',
          Number(comment.x || 0),
          Number(comment.y || 0),
          comment.selector || '',
          comment.elementText || '',
          comment.elementTag || '',
          comment.elementRect ? JSON.stringify(comment.elementRect) : '',
          comment.status || 'open',
          comment.createdAt || new Date().toISOString(),
          comment.resolvedAt || ''
        );
      }
      for (const version of deck.versions || []) {
        insertVersion.run(version.id || crypto.randomUUID(), deck.id, version.label || '', version.filePath || '', version.createdAt || new Date().toISOString());
      }
    }
    for (const entry of data.logs.slice(0, 200)) {
      insertLog.run(entry.id || crypto.randomUUID(), entry.level || 'info', entry.message || 'Event', JSON.stringify(entry.meta || {}), entry.createdAt || new Date().toISOString());
    }
    for (const entry of data.usageEvents.slice(0, 5000)) {
      insertUsage.run(
        entry.id || crypto.randomUUID(),
        entry.userId || '',
        entry.identityType || 'user',
        entry.identityKey || entry.userId || '',
        entry.action || 'generate',
        Number(entry.costCents || 0),
        entry.createdAt || new Date().toISOString()
      );
    }
    for (const entry of data.verificationTokens) {
      if (data.users.some((user) => user.id === entry.userId)) {
        insertVerificationToken.run(
          entry.token,
          entry.userId,
          entry.createdAt || new Date().toISOString(),
          entry.expiresAt || new Date().toISOString(),
          entry.usedAt || '',
          entry.pendingGuestUserId || ''
        );
      }
    }
    for (const entry of data.signupVerificationTokens) {
      insertSignupVerificationToken.run(
        entry.token,
        entry.email,
        entry.name || '',
        entry.pendingGuestUserId || '',
        entry.createdAt || new Date().toISOString(),
        entry.expiresAt || new Date().toISOString(),
        entry.usedAt || ''
      );
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    try {
      sqlite.exec('ROLLBACK');
    } catch (_rollbackError) {}
    throw error;
  }
}

function logEvent(level, message, meta = {}) {
  const entry = {
    id: crypto.randomUUID(),
    level,
    message: String(message || 'Unknown event'),
    meta,
    createdAt: new Date().toISOString()
  };
  console[level === 'error' ? 'error' : 'log'](`[${level}] ${entry.message}`, meta);
  try {
    const db = readDb();
    db.logs.unshift(entry);
    db.logs = db.logs.slice(0, 200);
    writeDb(db);
  } catch (error) {
    console.error('[error] Failed to persist log', error);
  }
  return entry;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const storedHash = Buffer.from(hash, 'hex');
  const test = crypto.scryptSync(password, salt, storedHash.length);
  return storedHash.length === test.length && crypto.timingSafeEqual(storedHash, test);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getUser(req, db) {
  const token = parseCookies(req).session;
  if (!token || !db.sessions[token]) return null;
  return db.users.find((user) => user.id === db.sessions[token].userId) || null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.isGuest ? '' : user.email,
    isGuest: Boolean(user.isGuest),
    emailVerified: Boolean(user.emailVerifiedAt),
    credits: Number(user.credits || 0),
    plan: user.plan || 'free'
  };
}

function hashIdentity(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 32);
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || req.ip || 'unknown';
}

function getTrialCookie(req) {
  return req._trialId || parseCookies(req).trial_id || '';
}

function setTrialCookie(res, trialId, maxAge = 60 * 60 * 24 * 90) {
  const parts = [`trial_id=${encodeURIComponent(trialId)}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  res.append('Set-Cookie', parts.join('; '));
}

function browserFingerprint(req) {
  return hashIdentity([
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || ''
  ].join('|'));
}

function getDeviceFingerprint(req) {
  return hashIdentity(req.headers['x-device-id'] || req.headers['user-agent'] || 'unknown-device');
}

function countUsageToday(db, predicate) {
  const today = dayKey();
  return (db.usageEvents || []).filter((entry) => String(entry.createdAt || '').startsWith(today) && predicate(entry)).length;
}

function freeSpendToday(db) {
  const today = dayKey();
  return (db.usageEvents || [])
    .filter((entry) => String(entry.createdAt || '').startsWith(today) && entry.action === 'generate')
    .reduce((sum, entry) => sum + Number(entry.costCents || 0), 0);
}

function usageSummaryForUser(db, user, req) {
  if (!user || user.isGuest) {
    const trialId = getTrialCookie(req);
    return {
      tier: 'guest',
      remaining: Math.max(0, QUOTAS.guestCookieDaily - countUsageToday(db, (entry) => entry.identityType === 'cookie' && entry.identityKey === hashIdentity(trialId))),
      dailyBudgetRemainingCents: Math.max(0, QUOTAS.freeDailyBudgetCents - freeSpendToday(db))
    };
  }
  return {
    tier: user.emailVerifiedAt ? user.plan || 'free' : 'unverified',
    remaining: user.emailVerifiedAt ? Number(user.credits || 0) : QUOTAS.unverifiedUserDaily,
    dailyBudgetRemainingCents: Math.max(0, QUOTAS.freeDailyBudgetCents - freeSpendToday(db))
  };
}

function createGuestUserAndSession(req, res, db) {
  let trialId = getTrialCookie(req);
  if (!trialId) {
    trialId = crypto.randomBytes(18).toString('hex');
    setTrialCookie(res, trialId);
  }
  req._trialId = trialId;
  const email = `guest-${hashIdentity(trialId)}@guest.slidestudio.local`;
  let guest = db.users.find((user) => user.email === email);
  if (!guest) {
    guest = {
      id: `guest-${crypto.randomUUID()}`,
      name: 'Guest',
      email,
      passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
      createdAt: new Date().toISOString(),
      emailVerifiedAt: '',
      credits: 0,
      plan: 'trial',
      isGuest: true
    };
    db.users.push(guest);
  }
  const sessionToken = crypto.randomBytes(32).toString('hex');
  db.sessions[sessionToken] = { userId: guest.id, createdAt: new Date().toISOString() };
  setSessionCookie(res, sessionToken);
  return guest;
}

function ensureGenerationAllowance({ req, res, db, user, template }) {
  const spend = freeSpendToday(db);
  if (spend + QUOTAS.generationCostCents > QUOTAS.freeDailyBudgetCents) {
    return { error: '今日免费额度已用完，请稍后再试或升级付费额度。', status: 429 };
  }

  const now = new Date().toISOString();
  if (!user || user.isGuest) {
    if (!BASIC_TRIAL_TEMPLATE_IDS.has(template.id)) {
      return { error: '未登录试用只能使用基础模板。注册并验证邮箱后可使用更多模板。', status: 403 };
    }
    const trialId = getTrialCookie(req) || crypto.randomBytes(18).toString('hex');
    if (!getTrialCookie(req)) setTrialCookie(res, trialId);
    req._trialId = trialId;
    const identities = [
      ['cookie', hashIdentity(trialId), QUOTAS.guestCookieDaily],
      ['device', getDeviceFingerprint(req), QUOTAS.guestDeviceDaily],
      ['browser', browserFingerprint(req), QUOTAS.guestBrowserDaily],
      ['ip', hashIdentity(getClientIp(req)), QUOTAS.guestIpDaily]
    ];
    const exceeded = identities.find(([type, key, limit]) => countUsageToday(db, (entry) => entry.identityType === type && entry.identityKey === key) >= limit);
    if (exceeded) {
      return { error: '免费试用额度已用完。注册并验证邮箱后可获得正式额度。', status: 429 };
    }
    return {
      spend: () => {
        for (const [type, key] of identities) {
          db.usageEvents.unshift({
            id: crypto.randomUUID(),
            userId: user?.id || '',
            identityType: type,
            identityKey: key,
            action: 'generate',
            costCents: type === 'cookie' ? QUOTAS.generationCostCents : 0,
            createdAt: now
          });
        }
      }
    };
  }

  if (!user.emailVerifiedAt) {
    const used = countUsageToday(db, (entry) => entry.identityType === 'user' && entry.identityKey === user.id);
    if (used >= QUOTAS.unverifiedUserDaily) {
      return { error: '请先验证邮箱，验证后会发放正式免费额度。', status: 403 };
    }
  } else if ((user.plan || 'free') !== 'paid') {
    if (Number(user.credits || 0) <= 0) return { error: '你的免费额度已用完，可以购买额度继续生成。', status: 402 };
  }

  return {
    spend: () => {
      if (user.emailVerifiedAt && (user.plan || 'free') !== 'paid') user.credits = Math.max(0, Number(user.credits || 0) - 1);
      db.usageEvents.unshift({
        id: crypto.randomUUID(),
        userId: user.id,
        identityType: 'user',
        identityKey: user.id,
        action: 'generate',
        costCents: QUOTAS.generationCostCents,
        createdAt: now
      });
    }
  };
}

function createEmailVerification(db, user, options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3).toISOString();
  db.verificationTokens.unshift({
    token,
    userId: user.id,
    pendingGuestUserId: options.pendingGuestUserId || '',
    createdAt: now.toISOString(),
    expiresAt,
    usedAt: ''
  });
  return `${APP_BASE_URL}/api/verify-email?token=${token}`;
}

function createSignupVerification(db, { email, name, pendingGuestUserId = '' }) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 3).toISOString();
  db.signupVerificationTokens.unshift({
    token,
    email,
    name,
    pendingGuestUserId,
    createdAt: now.toISOString(),
    expiresAt,
    usedAt: ''
  });
  return `${APP_BASE_URL}/?signup_token=${encodeURIComponent(token)}`;
}

function mergeGuestProjectsIntoUser(db, guestUserId, user) {
  if (!guestUserId || !user || guestUserId === user.id) return { decks: 0 };
  const guest = db.users.find((item) => item.id === guestUserId && item.isGuest);
  if (!guest) return { decks: 0 };

  let decks = 0;
  for (const deck of db.decks || []) {
    if (deck.userId !== guest.id) continue;
    deck.userId = user.id;
    deck.updatedAt = deck.updatedAt || new Date().toISOString();
    decks += 1;
  }

  for (const entry of db.usageEvents || []) {
    if (entry.userId === guest.id) entry.userId = user.id;
  }

  for (const [token, session] of Object.entries(db.sessions || {})) {
    if (session.userId === guest.id) delete db.sessions[token];
  }

  if (decks > 0) {
    db.users = db.users.filter((item) => item.id !== guest.id);
  }

  return { decks };
}

function createVerificationEmailPreview(user, verificationLink) {
  return {
    to: user.email,
    from: EMAIL_FROM,
    subject: 'Verify your Slide Studio email',
    provider: 'gmail',
    verificationLink,
    gmailUrl: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`from:${formatEmailAddress(EMAIL_FROM)} Slide Studio verify`)}`,
    expiresIn: '3 days',
    delivered: false,
    delivery: 'local-preview'
  };
}

function hasSmtpConfig() {
  return Boolean(SMTP_CONFIG.host && SMTP_CONFIG.user && SMTP_CONFIG.pass);
}

function formatEmailAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/<([^>]+)>/);
  return match ? match[1].trim() : text;
}

function base64Line(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function smtpCommand(socket, command, expected = []) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      if (expected.length && !expected.includes(code)) {
        reject(new Error(`SMTP command failed with ${code}: ${buffer.trim()}`));
      } else {
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    if (command) socket.write(`${command}\r\n`);
  });
}

async function sendSmtpMail({ to, from, subject, text, html }) {
  const socket = SMTP_CONFIG.secure
    ? tls.connect({ host: SMTP_CONFIG.host, port: SMTP_CONFIG.port, servername: SMTP_CONFIG.host })
    : net.connect({ host: SMTP_CONFIG.host, port: SMTP_CONFIG.port });
  socket.setTimeout(15000);
  socket.on('timeout', () => socket.destroy(new Error('SMTP connection timed out.')));

  try {
    await smtpCommand(socket, '', [220]);
    await smtpCommand(socket, `EHLO ${SMTP_CONFIG.host}`, [250]);
    await smtpCommand(socket, 'AUTH LOGIN', [334]);
    await smtpCommand(socket, base64Line(SMTP_CONFIG.user), [334]);
    await smtpCommand(socket, base64Line(SMTP_CONFIG.pass), [235]);
    await smtpCommand(socket, `MAIL FROM:<${formatEmailAddress(from)}>`, [250]);
    await smtpCommand(socket, `RCPT TO:<${formatEmailAddress(to)}>`, [250, 251]);
    await smtpCommand(socket, 'DATA', [354]);
    const boundary = `slide-studio-${crypto.randomBytes(8).toString('hex')}`;
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      '',
      `--${boundary}--`,
      '.'
    ].join('\r\n');
    await smtpCommand(socket, message, [250]);
    await smtpCommand(socket, 'QUIT', [221]);
  } finally {
    socket.end();
  }
}

async function sendVerificationEmail(user, verificationLink) {
  const preview = createVerificationEmailPreview(user, verificationLink);
  if (!hasSmtpConfig()) return preview;

  const text = `Verify your Slide Studio email:\n\n${verificationLink}\n\nThis link expires in 3 days.`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#25231f;line-height:1.5">
      <h1 style="font-size:24px;margin:0 0 12px">Verify your Slide Studio email</h1>
      <p>Click the button below to unlock your free credits.</p>
      <p><a href="${escapeHtml(verificationLink)}" style="display:inline-block;padding:12px 16px;background:#17614f;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Verify email</a></p>
      <p style="color:#625f58;font-size:13px">This link expires in 3 days.</p>
    </div>
  `;
  await sendSmtpMail({ to: user.email, from: EMAIL_FROM, subject: preview.subject, text, html });
  return { ...preview, delivered: true, delivery: 'smtp' };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicDeck(deck) {
  if (!deck) return null;
  const { filePath, originalHtmlPath, targetContext, ...safeDeck } = deck;
  safeDeck.messages ||= [];
  safeDeck.comments ||= [];
  safeDeck.versions = (safeDeck.versions || []).map(({ filePath: _filePath, ...version }) => version);
  return safeDeck;
}

function addDeckProgress(db, deck, title, detail = '', status = 'done') {
  if (!deck) return;
  deck.messages ||= [];
  deck.messages.push({
    id: crypto.randomUUID(),
    role: 'progress',
    text: JSON.stringify({ title, detail, status }),
    createdAt: new Date().toISOString()
  });
  deck.updatedAt = new Date().toISOString();
  writeDb(db);
}

function sanitizeFileName(name, fallback = 'slide-deck') {
  return String(name || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80) || fallback;
}

function findChromeExecutable() {
  return CHROME_PATHS.find((candidate) => fs.existsSync(candidate)) || '';
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getAuthorizedDeck(req, res, db = readDb()) {
  const user = getUser(req, db);
  if (!user) {
    res.status(401).json({ error: 'Login required.' });
    return {};
  }
  const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
  if (!deck) {
    res.status(404).json({ error: 'Deck not found.' });
    return { user };
  }
  if (!deck.filePath || !fs.existsSync(deck.filePath)) {
    res.status(404).json({ error: 'Deck HTML file is missing.' });
    return { user, deck };
  }
  const resolvedPath = path.resolve(deck.filePath);
  if (!resolvedPath.startsWith(path.resolve(GENERATED_DIR))) {
    res.status(403).json({ error: 'Forbidden.' });
    return { user, deck };
  }
  return { user, deck, resolvedPath };
}

function buildPrintableHtml(html) {
  const printCss = `
<style id="slide-studio-export-css">
@page { size: 1920px 1080px; margin: 0; }
@media print {
  html, body { width: 1920px !important; height: auto !important; margin: 0 !important; overflow: visible !important; background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .deck-viewport { position: static !important; width: 1920px !important; height: auto !important; overflow: visible !important; background: #fff !important; }
  .deck-stage { position: static !important; width: 1920px !important; height: auto !important; transform: none !important; background: none !important; }
  .slide { position: relative !important; display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; width: 1920px !important; height: 1080px !important; break-after: page; page-break-after: always; transform: none !important; }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .deck-controls, .edit-toggle, .export-button, .edit-hotzone { display: none !important; }
}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${printCss}\n</head>`);
  return `${printCss}\n${html}`;
}

function setSessionCookie(res, token, maxAge) {
  const parts = [`session=${token || ''}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  res.append('Set-Cookie', parts.join('; '));
}

const templates = [
  { id: 'sakura-chroma', slug: 'sakura-chroma', name: 'Sakura Chroma', category: 'Design & creative', accent: '#E54489', uses: 2150, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'soft-editorial', slug: 'soft-editorial', name: 'Soft Editorial', category: 'General', accent: '#D7DE62', uses: 9602, deckPath: '/ai-notes-launch.html' },
  { id: 'blue-professional', slug: 'blue-professional', name: 'Blue Professional', category: 'Go-to-market', accent: '#3F8BC4', uses: 1888, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'creative-mode', slug: 'creative-mode', name: 'Creative Mode', category: 'Design & creative', accent: '#F09131', uses: 1470, deckPath: '/ai-creation-sakura-chroma.html' },
  { id: 'long-table', slug: 'long-table', name: 'Long Table', category: 'Product research', accent: '#3D9F47', uses: 843, deckPath: '/ai-notes-launch.html' },
  { id: 'job-candidate', slug: 'sakura-chroma', name: 'Job Case Study', category: 'Job & career', accent: '#E5392A', uses: 522, deckPath: '/ai-creation-sakura-chroma.html' }
];

const artifactTypes = [
  {
    id: 'product-walkthrough',
    name: 'Product walkthrough',
    focus: 'Explain a product through a user journey, demo states, workflow, data proof, and delivery moment.',
    requiredSlides: 'intent/problem, product walkthrough, workflow diagram, benchmark or adoption data, before/after comparison, delivery/export moment',
    interactions: 'a clickable walkthrough stepper, a flow node selector, and at least one metric/chart state toggle'
  },
  {
    id: 'startup-pitch',
    name: 'Startup pitch',
    focus: 'Turn a startup narrative into a web-native pitch artifact with wedge, market proof, product demo, traction, and roadmap.',
    requiredSlides: 'category insight, competitive asymmetry, product demo, market or traction data, business model, roadmap, ask/next step',
    interactions: 'a competitive map or wedge selector, a traction/market metric toggle, and a product demo walkthrough'
  },
  {
    id: 'ai-project-showcase',
    name: 'AI project showcase',
    focus: 'Show an AI project as a working narrative: user problem, model/workflow, architecture, evals, risks, and outcome.',
    requiredSlides: 'problem, AI workflow, architecture diagram, eval dashboard, product walkthrough, risk controls, outcome',
    interactions: 'a clickable AI workflow, an eval metric toggle, and an architecture or state walkthrough'
  },
  {
    id: 'technical-proposal',
    name: 'Technical proposal',
    focus: 'Explain a technical proposal with system flow, tradeoffs, implementation stages, risk controls, and rollout plan.',
    requiredSlides: 'current state, target architecture, data/process flow, tradeoff matrix, phased rollout, risk/mitigation, decision request',
    interactions: 'a clickable architecture flow, a tradeoff matrix toggle, and a phased rollout selector'
  },
  {
    id: 'data-story',
    name: 'Data story',
    focus: 'Build a data-heavy narrative that guides the audience through benchmarks, patterns, implications, and action.',
    requiredSlides: 'question, data landscape, segmented chart, comparison view, insight flow, recommendation, action plan',
    interactions: 'multiple metric toggles, at least one comparative chart, and a clickable insight path'
  },
  {
    id: 'sales-narrative',
    name: 'Sales narrative',
    focus: 'Create a sales artifact that moves from pain to proof to product walkthrough to buyer-specific next steps.',
    requiredSlides: 'buyer pain, cost of status quo, solution walkthrough, proof/data, implementation path, objection handling, close plan',
    interactions: 'a pain-to-value walkthrough, ROI or impact metric toggle, and implementation timeline selector'
  }
];

function getArtifactType(id) {
  return artifactTypes.find((item) => item.id === id) || artifactTypes[0];
}

function parseTargetContext(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_error) {
    return {};
  }
}

function artifactContextText(artifactType) {
  return `Artifact type: ${artifactType.name}
Focus: ${artifactType.focus}
Expected narrative sections: ${artifactType.requiredSlides}
Required interactive modules: ${artifactType.interactions}`;
}

const FALLBACK_VIEWPORT_BASE = `
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--stage-bg, #000); }
.deck-viewport { position: fixed; inset: 0; overflow: hidden; background: var(--stage-bg, #000); }
.deck-stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; transform-origin: 0 0; background: var(--slide-bg, #fff); }
.slide { position: absolute; inset: 0; width: 1920px; height: 1080px; overflow: hidden; display: block; visibility: hidden; opacity: 0; pointer-events: none; background: var(--slide-bg, #fff); }
.slide.active, .slide.visible { visibility: visible; opacity: 1; pointer-events: auto; z-index: 1; }
@media print { html, body { width: 1920px; height: auto; overflow: visible; background: #fff; } .deck-viewport, .deck-stage { position: static; transform: none !important; overflow: visible; } .slide { position: relative; display: block !important; visibility: visible !important; opacity: 1 !important; width: 1920px; height: 1080px; break-after: page; } .deck-controls { display: none !important; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.2s !important; } }
`;

const FALLBACK_HTML_TEMPLATE = `
Use a complete HTML document with .deck-viewport, #deckStage.deck-stage, multiple <section class="slide"> elements, fixed 1920x1080 slide layout, inline CSS, and inline JavaScript that scales #deckStage to the viewport and supports keyboard navigation.
`;

const FALLBACK_ANIMATION_PATTERNS = `
Use restrained reveal animations only on the active slide, with reduced-motion support. Keep content legible and avoid layout shifts.
`;

const FALLBACK_DESIGN_MD = `
Design direction: premium productivity tool, editorial but practical. Use crisp typography, clear hierarchy, generous whitespace, visible data/storytelling blocks, and a balanced palette that is not dominated by a single hue. The deck should feel finished enough for a portfolio demo.
`;

const SLIDE_RUNTIME_CSS = `
<style id="slide-studio-runtime-css">
html, body { width: 100% !important; height: 100% !important; margin: 0 !important; overflow: hidden !important; }
.deck-viewport { position: fixed !important; inset: 0 !important; overflow: hidden !important; }
.deck-stage { position: absolute !important; left: 0 !important; top: 0 !important; width: 1920px !important; height: 1080px !important; overflow: hidden !important; transform-origin: 0 0 !important; }
.deck-stage > .slide { position: absolute !important; inset: 0 !important; width: 1920px !important; height: 1080px !important; overflow: hidden !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
.deck-stage > .slide.active, .deck-stage > .slide.visible { visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; z-index: 1 !important; }
@media print {
  html, body { width: 1920px !important; height: auto !important; overflow: visible !important; }
  .deck-viewport, .deck-stage { position: static !important; transform: none !important; width: 1920px !important; height: auto !important; overflow: visible !important; }
  .deck-stage > .slide { position: relative !important; display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; width: 1920px !important; height: 1080px !important; break-after: page; page-break-after: always; transform: none !important; }
  .deck-stage > .slide:last-child { break-after: auto; page-break-after: auto; }
}
</style>`;

function readTextFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent('error', 'Failed to read generation context file', { filePath, message: error.message });
    return fallback;
  }
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return trimmed || 'https://api.openai.com/v1';
}

function normalizeProviderConfig(config = {}) {
  const provider = String(config.provider || 'OpenAI').trim() || 'OpenAI';
  const lower = provider.toLowerCase();
  const qwenBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const defaultBaseUrl = lower.includes('qwen') || lower.includes('千问') || lower.includes('dashscope')
    ? qwenBase
    : 'https://api.openai.com/v1';
  return {
    provider,
    model: String(config.model || (defaultBaseUrl === qwenBase ? 'qwen-plus' : 'gpt-4.1')).trim(),
    baseUrl: normalizeBaseUrl(config.baseUrl || defaultBaseUrl),
    apiKey: String(config.apiKey || '').trim(),
    output: String(config.output || 'Frontend (HTML)')
  };
}

function getServerModelConfig() {
  return normalizeProviderConfig({
    provider: process.env.OPENAI_PROVIDER || process.env.AI_PROVIDER || 'OpenAI',
    model: process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-4.1',
    baseUrl: process.env.OPENAI_BASE_URL || process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '',
    output: 'Frontend (HTML)'
  });
}

function summarizeDesignRecipe(designMd, template) {
  const text = String(designMd || FALLBACK_DESIGN_MD);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'))
    .filter((line) => /color|palette|typography|font|layout|grid|spacing|radius|shadow|button|card|visual|tone|motion|animation|background|accent|heading|data|chart/i.test(line))
    .slice(0, 42);
  const summary = lines.join('\n').slice(0, 5200);
  return summary || `Template: ${template.name}. ${FALLBACK_DESIGN_MD}`;
}

function buildGenerationPrompt({ prompt, template, artifactType, designMd }) {
  const designSummary = summarizeDesignRecipe(designMd, template);
  const artifactContext = artifactContextText(artifactType);
  return {
    system: `You are Slide Studio's senior presentation designer. Return only valid JSON for a high-quality web-native HTML presentation.

The app will render the final HTML locally, so do not write a full HTML document, CSS file, or JavaScript runtime. Your job is the narrative, page content, visual intent, data, and interaction design.

JSON schema:
{
  "title": "deck title",
  "subtitle": "short framing line",
  "themeNotes": "visual direction in one sentence",
  "slides": [
    {
      "kicker": "short label",
      "title": "slide title",
      "subtitle": "supporting sentence",
      "layout": "hero | split | metrics | workflow | comparison | chart | roadmap | closing",
      "bullets": ["3 to 5 concise bullets"],
      "metrics": [{"label":"", "value":"", "note":""}],
      "steps": [{"label":"", "title":"", "detail":""}],
      "details": [{"trigger":"", "title":"", "body":"", "type":"hotspot | timeline | card"}],
      "reveals": ["short staged point"],
      "beforeAfter": {"beforeTitle":"", "beforeBody":"", "afterTitle":"", "afterBody":""},
      "segments": [{"label":"", "title":"", "body":""}],
      "chart": [{"label":"", "value": 42}],
      "chartDatasets": [{"label":"", "insight":"", "data":[{"label":"", "value": 42}]}],
      "callout": "one crisp insight",
      "speakerNote": "why this slide matters"
    }
  ]
}

Rules:
- Return JSON only. No markdown fences.
- Use 5 to 7 slides unless the user explicitly requests another count.
- Every slide must have concrete, presentation-ready copy, not placeholders.
- Include at least one workflow/process slide, one data/chart slide, and one comparison or metrics slide.
- Design for a polished 1920x1080 HTML deck with interactive controls rendered by the app.
- Use web-native interaction deliberately: add clickable details for drilldown, reveals for staged explanation, beforeAfter for transformation stories, segments for multiple perspectives, and chartDatasets for switchable metrics.
- If data is illustrative, make that clear in labels or notes.`,
    user: `User prompt:
${prompt}

Artifact direction:
${artifactContext}

Selected template:
${template.name} (${template.slug})

Compact template recipe:
${designSummary}

Create the JSON design spec now.`
  };
}

async function callChatCompletions({ modelConfig, messages, maxTokens = EDIT_MAX_TOKENS }) {
  if (!modelConfig.apiKey) {
    throw new Error('The server model API key is not configured yet. Ask the workspace owner to set OPENAI_API_KEY or AI_API_KEY.');
  }
  const endpoint = `${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`;
  const body = {
    model: modelConfig.model,
    messages
  };
  if (/^gpt-5/i.test(modelConfig.model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.temperature = 0.72;
    body.max_tokens = maxTokens;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${modelConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: controller.signal
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error(`AI API request timed out after ${Math.round(AI_REQUEST_TIMEOUT_MS / 1000)} seconds.`);
    throw error;
  }).finally(() => clearTimeout(timeout));
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { error: { message: text } };
  }
  if (!response.ok) {
    throw new Error(data.error?.message || `AI API request failed (${response.status})`);
  }
  const content = data.choices?.[0]?.message?.content || data.output_text || '';
  if (!content) throw new Error('AI API returned an empty response.');
  return content;
}

function extractHtml(raw) {
  let html = String(raw || '').trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) html = html.slice(start);
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error('Generated output was not a complete HTML document.');
  }
  if (!/deck-stage/i.test(html) || !/class=["'][^"']*\bslide\b/i.test(html)) {
    throw new Error('Generated HTML is missing the fixed-stage slide structure.');
  }
  html = html.replace(/<style id=["']slide-studio-runtime-css["'][\s\S]*?<\/style>\s*/i, '');
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${SLIDE_RUNTIME_CSS}\n</head>`);
  if (/<body[\s>]/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>\n${SLIDE_RUNTIME_CSS}`);
  return `${SLIDE_RUNTIME_CSS}\n${html}`;
}

function normalizeDeckSpec(rawSpec, prompt, artifactType) {
  const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  const normalizedSlides = slides.slice(0, 9).map((slide, index) => ({
    kicker: String(slide.kicker || `Slide ${index + 1}`).slice(0, 48),
    title: String(slide.title || `Section ${index + 1}`).slice(0, 96),
    subtitle: String(slide.subtitle || '').slice(0, 220),
    layout: ['hero', 'split', 'metrics', 'workflow', 'comparison', 'chart', 'roadmap', 'closing'].includes(slide.layout) ? slide.layout : 'split',
    bullets: Array.isArray(slide.bullets) ? slide.bullets.slice(0, 5).map((item) => String(item).slice(0, 180)) : [],
    metrics: Array.isArray(slide.metrics) ? slide.metrics.slice(0, 4).map((item) => ({
      label: String(item.label || '').slice(0, 44),
      value: String(item.value || '').slice(0, 32),
      note: String(item.note || '').slice(0, 90)
    })) : [],
    steps: Array.isArray(slide.steps) ? slide.steps.slice(0, 5).map((item, stepIndex) => ({
      label: String(item.label || `${stepIndex + 1}`).slice(0, 28),
      title: String(item.title || item.label || `Step ${stepIndex + 1}`).slice(0, 64),
      detail: String(item.detail || '').slice(0, 180)
    })) : [],
    details: Array.isArray(slide.details) ? slide.details.slice(0, 5).map((item, detailIndex) => ({
      trigger: String(item.trigger || item.label || `Detail ${detailIndex + 1}`).slice(0, 36),
      title: String(item.title || item.trigger || `Detail ${detailIndex + 1}`).slice(0, 72),
      body: String(item.body || item.detail || '').slice(0, 220),
      type: ['hotspot', 'timeline', 'card'].includes(item.type) ? item.type : 'card'
    })).filter((item) => item.title || item.body) : [],
    reveals: Array.isArray(slide.reveals) ? slide.reveals.slice(0, 5).map((item) => String(item).slice(0, 150)).filter(Boolean) : [],
    beforeAfter: slide.beforeAfter && typeof slide.beforeAfter === 'object' ? {
      beforeTitle: String(slide.beforeAfter.beforeTitle || 'Before').slice(0, 64),
      beforeBody: String(slide.beforeAfter.beforeBody || '').slice(0, 220),
      afterTitle: String(slide.beforeAfter.afterTitle || 'After').slice(0, 64),
      afterBody: String(slide.beforeAfter.afterBody || '').slice(0, 220)
    } : null,
    segments: Array.isArray(slide.segments) ? slide.segments.slice(0, 4).map((item, segmentIndex) => ({
      label: String(item.label || `View ${segmentIndex + 1}`).slice(0, 28),
      title: String(item.title || item.label || `View ${segmentIndex + 1}`).slice(0, 70),
      body: String(item.body || item.detail || '').slice(0, 220)
    })).filter((item) => item.title || item.body) : [],
    chart: Array.isArray(slide.chart) ? slide.chart.slice(0, 6).map((item) => ({
      label: String(item.label || '').slice(0, 42),
      value: Math.max(0, Math.min(100, Number(item.value) || 0))
    })) : [],
    chartDatasets: Array.isArray(slide.chartDatasets) ? slide.chartDatasets.slice(0, 4).map((dataset, datasetIndex) => ({
      label: String(dataset.label || `Metric ${datasetIndex + 1}`).slice(0, 32),
      insight: String(dataset.insight || '').slice(0, 150),
      data: Array.isArray(dataset.data) ? dataset.data.slice(0, 6).map((item) => ({
        label: String(item.label || '').slice(0, 42),
        value: Math.max(0, Math.min(100, Number(item.value) || 0))
      })) : []
    })).filter((dataset) => dataset.data.length) : [],
    callout: String(slide.callout || '').slice(0, 180),
    speakerNote: String(slide.speakerNote || '').slice(0, 220)
  }));

  if (!normalizedSlides.length) {
    normalizedSlides.push({
      kicker: artifactType.name,
      title: String(prompt || 'Generated presentation').slice(0, 96),
      subtitle: artifactType.focus,
      layout: 'hero',
      bullets: ['A focused narrative generated from the user prompt.', 'A web-native artifact structure with reusable runtime controls.', 'Ready for refinement through chat edits.'],
      metrics: [],
      steps: [],
      details: [],
      reveals: [],
      beforeAfter: null,
      segments: [],
      chart: [],
      chartDatasets: [],
      callout: 'Generated with a lightweight structured pipeline.',
      speakerNote: ''
    });
  }

  return {
    title: String(spec.title || prompt || 'Generated deck').slice(0, 100),
    subtitle: String(spec.subtitle || artifactType.focus || '').slice(0, 220),
    themeNotes: String(spec.themeNotes || '').slice(0, 220),
    slides: normalizedSlides
  };
}

function themeForTemplate(template) {
  const themes = {
    'sakura-chroma': {
      bg: '#140f16',
      surface: '#fff7fb',
      ink: '#211821',
      muted: '#775f6e',
      accent: '#e54489',
      accent2: '#29b6c8',
      accent3: '#f3c744',
      font: "'Albert Sans', 'Inter', Arial, sans-serif",
      display: "'Big Shoulders Display', 'Albert Sans', Arial, sans-serif"
    },
    'soft-editorial': {
      bg: '#f6f1e8',
      surface: '#fffdf8',
      ink: '#25231f',
      muted: '#69645a',
      accent: '#17614f',
      accent2: '#d7de62',
      accent3: '#d97045',
      font: "'Inter', 'Noto Sans SC', Arial, sans-serif",
      display: "'Inter', 'Noto Sans SC', Arial, sans-serif"
    },
    'blue-professional': {
      bg: '#eef5fa',
      surface: '#ffffff',
      ink: '#18283a',
      muted: '#66798b',
      accent: '#2d75ad',
      accent2: '#55b8a6',
      accent3: '#f0b84d',
      font: "'Inter', Arial, sans-serif",
      display: "'Inter', Arial, sans-serif"
    },
    'creative-mode': {
      bg: '#fff7ed',
      surface: '#ffffff',
      ink: '#2a2118',
      muted: '#705f4f',
      accent: '#f09131',
      accent2: '#6d56d8',
      accent3: '#1aa37a',
      font: "'Inter', Arial, sans-serif",
      display: "'Inter', Arial, sans-serif"
    },
    'long-table': {
      bg: '#f2f5ef',
      surface: '#ffffff',
      ink: '#1f2a20',
      muted: '#5e6b60',
      accent: '#3d9f47',
      accent2: '#315f9f',
      accent3: '#c98d25',
      font: "'Inter', Arial, sans-serif",
      display: "'Inter', Arial, sans-serif"
    }
  };
  return themes[template.id] || themes[template.slug] || themes['soft-editorial'];
}

function renderList(items) {
  if (!items.length) return '';
  return `<ul class="bullet-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderMetrics(metrics) {
  if (!metrics.length) return '';
  return `<div class="metric-grid">${metrics.map((item) => `
    <div class="metric-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <em>${escapeHtml(item.note)}</em>
    </div>
  `).join('')}</div>`;
}

function renderSteps(steps, slideIndex) {
  if (!steps.length) return '';
  return `<div class="stepper" data-stepper="${slideIndex}">
    <div class="step-buttons">${steps.map((step, index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-step="${index}">${escapeHtml(step.label)}</button>`).join('')}</div>
    <div class="step-panels">${steps.map((step, index) => `
      <article class="${index === 0 ? 'active' : ''}" data-panel="${index}">
        <b>${escapeHtml(step.title)}</b>
        <p>${escapeHtml(step.detail)}</p>
      </article>
    `).join('')}</div>
  </div>`;
}

function renderDetails(details, slideIndex) {
  if (!details.length) return '';
  return `<div class="detail-module" data-detail-module="${slideIndex}">
    <div class="detail-triggers">${details.map((detail, index) => `
      <button type="button" class="detail-trigger ${index === 0 ? 'active' : ''}" data-detail="${index}" data-detail-type="${escapeHtml(detail.type)}">
        <span>${String(index + 1).padStart(2, '0')}</span>
        <b>${escapeHtml(detail.trigger)}</b>
      </button>
    `).join('')}</div>
    <div class="detail-panels">${details.map((detail, index) => `
      <article class="detail-panel ${index === 0 ? 'active' : ''}" data-detail-panel="${index}">
        <small>${escapeHtml(detail.type)}</small>
        <b>${escapeHtml(detail.title)}</b>
        <p>${escapeHtml(detail.body)}</p>
      </article>
    `).join('')}</div>
  </div>`;
}

function renderBeforeAfter(beforeAfter, slideIndex) {
  if (!beforeAfter || (!beforeAfter.beforeBody && !beforeAfter.afterBody)) return '';
  return `<div class="before-after" data-before-after="${slideIndex}" style="--split:50%">
    <article class="ba-card ba-before">
      <small>Before</small>
      <b>${escapeHtml(beforeAfter.beforeTitle)}</b>
      <p>${escapeHtml(beforeAfter.beforeBody)}</p>
    </article>
    <article class="ba-card ba-after">
      <small>After</small>
      <b>${escapeHtml(beforeAfter.afterTitle)}</b>
      <p>${escapeHtml(beforeAfter.afterBody)}</p>
    </article>
    <input type="range" min="18" max="82" value="50" aria-label="Before after comparison">
    <span class="ba-handle"></span>
  </div>`;
}

function renderSegments(segments, slideIndex) {
  if (!segments.length) return '';
  return `<div class="segment-module" data-segments="${slideIndex}">
    <div class="segment-tabs">${segments.map((segment, index) => `
      <button type="button" class="${index === 0 ? 'active' : ''}" data-segment="${index}">${escapeHtml(segment.label)}</button>
    `).join('')}</div>
    <div class="segment-panels">${segments.map((segment, index) => `
      <article class="${index === 0 ? 'active' : ''}" data-segment-panel="${index}">
        <b>${escapeHtml(segment.title)}</b>
        <p>${escapeHtml(segment.body)}</p>
      </article>
    `).join('')}</div>
  </div>`;
}

function renderChart(chart) {
  if (!chart.length) return '';
  const max = Math.max(1, ...chart.map((item) => item.value));
  return `<div class="bar-chart">${chart.map((item) => `
    <div class="bar-row">
      <span>${escapeHtml(item.label)}</span>
      <div><i style="width:${Math.max(8, Math.round((item.value / max) * 100))}%"></i></div>
      <b>${escapeHtml(item.value)}</b>
    </div>
  `).join('')}</div>`;
}

function renderChartDatasets(datasets, slideIndex) {
  if (!datasets.length) return '';
  return `<div class="chart-toggle" data-chart-toggle="${slideIndex}">
    <div class="chart-tabs">${datasets.map((dataset, index) => `
      <button type="button" class="${index === 0 ? 'active' : ''}" data-chart-dataset="${index}">${escapeHtml(dataset.label)}</button>
    `).join('')}</div>
    <div class="chart-toggle-panels">${datasets.map((dataset, index) => {
      const max = Math.max(1, ...dataset.data.map((item) => item.value));
      return `<article class="${index === 0 ? 'active' : ''}" data-chart-panel="${index}">
        <div class="dataset-bars">${dataset.data.map((item) => `
          <div class="bar-row">
            <span>${escapeHtml(item.label)}</span>
            <div><i style="width:${Math.max(8, Math.round((item.value / max) * 100))}%"></i></div>
            <b>${escapeHtml(item.value)}</b>
          </div>
        `).join('')}</div>
        ${dataset.insight ? `<p>${escapeHtml(dataset.insight)}</p>` : ''}
      </article>`;
    }).join('')}</div>
  </div>`;
}

function renderSlide(slide, index) {
  const revealItems = slide.reveals;
  const body = [
    renderList(slide.bullets),
    renderMetrics(slide.metrics),
    renderSteps(slide.steps, index),
    renderDetails(slide.details, index),
    renderBeforeAfter(slide.beforeAfter, index),
    renderSegments(slide.segments, index),
    revealItems.length ? `<div class="reveal-stack">${revealItems.map((item, revealIndex) => `<div class="reveal-item" data-reveal="${revealIndex}">${escapeHtml(item)}</div>`).join('')}</div>` : '',
    renderChartDatasets(slide.chartDatasets, index),
    renderChart(slide.chart)
  ].filter(Boolean).join('\n');
  return `<section class="slide ${index === 0 ? 'active visible' : ''}" data-layout="${escapeHtml(slide.layout)}">
    <div class="slide-chrome">
      <span>${escapeHtml(slide.kicker)}</span>
      <span>${String(index + 1).padStart(2, '0')}</span>
    </div>
    <main class="slide-layout">
      <div class="copy-block">
        <p class="kicker">${escapeHtml(slide.kicker)}</p>
        <h1>${escapeHtml(slide.title)}</h1>
        ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ''}
        ${slide.callout ? `<div class="callout">${escapeHtml(slide.callout)}</div>` : ''}
      </div>
      <div class="visual-block">${body || '<div class="empty-visual">Ready for refinement</div>'}</div>
    </main>
    ${slide.speakerNote ? `<aside class="speaker-note">${escapeHtml(slide.speakerNote)}</aside>` : ''}
  </section>`;
}

function renderDeckHtmlFromSpec(spec, template, artifactType) {
  const theme = themeForTemplate(template);
  const slides = spec.slides.map(renderSlide).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(spec.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Albert+Sans:wght@400;500;600;700;900&family=Big+Shoulders+Display:wght@700;900&family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --stage-bg: ${theme.bg};
      --slide-bg: ${theme.surface};
      --ink: ${theme.ink};
      --muted: ${theme.muted};
      --accent: ${theme.accent};
      --accent-2: ${theme.accent2};
      --accent-3: ${theme.accent3};
      --font: ${theme.font};
      --display: ${theme.display};
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--stage-bg); color: var(--ink); font-family: var(--font); }
    .deck-viewport { position: fixed; inset: 0; overflow: hidden; background: var(--stage-bg); }
    .deck-stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; transform-origin: 0 0; background: var(--slide-bg); }
    .slide { position: absolute; inset: 0; width: 1920px; height: 1080px; overflow: hidden; display: block; visibility: hidden; opacity: 0; pointer-events: none; background:
      radial-gradient(circle at 12% 18%, color-mix(in srgb, var(--accent-2) 18%, transparent), transparent 28%),
      linear-gradient(135deg, color-mix(in srgb, var(--slide-bg) 90%, var(--accent) 10%), var(--slide-bg)); padding: 72px; }
    .slide.active, .slide.visible { visibility: visible; opacity: 1; pointer-events: auto; z-index: 1; }
    .slide::after { content: ""; position: absolute; inset: 32px; border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent); pointer-events: none; }
    .slide-chrome { position: relative; z-index: 2; display: flex; justify-content: space-between; align-items: center; color: var(--muted); text-transform: uppercase; font-size: 24px; font-weight: 800; letter-spacing: 0; }
    .slide-layout { position: relative; z-index: 2; height: 844px; display: grid; grid-template-columns: 0.92fr 1.08fr; gap: 72px; align-items: center; }
    .copy-block h1 { margin: 0; font-family: var(--display); font-size: 104px; line-height: 0.94; letter-spacing: 0; max-width: 780px; }
    .kicker { margin: 0 0 22px; color: var(--accent); text-transform: uppercase; font-weight: 900; font-size: 24px; letter-spacing: 0; }
    .subtitle { margin: 28px 0 0; color: var(--muted); font-size: 34px; line-height: 1.28; max-width: 720px; }
    .callout { margin-top: 34px; padding: 24px 28px; border-left: 10px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, white); font-size: 26px; line-height: 1.3; font-weight: 700; max-width: 720px; }
    .visual-block { min-height: 610px; display: grid; align-content: center; gap: 26px; }
    .bullet-list { display: grid; gap: 18px; margin: 0; padding: 0; list-style: none; }
    .bullet-list li { padding: 22px 26px; background: rgba(255,255,255,0.72); border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent); font-size: 28px; line-height: 1.25; font-weight: 650; }
    .metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
    .metric-card { min-height: 172px; padding: 26px; background: var(--ink); color: var(--slide-bg); display: grid; align-content: space-between; }
    .metric-card span { color: color-mix(in srgb, var(--slide-bg) 70%, var(--accent-2)); font-size: 20px; text-transform: uppercase; font-weight: 800; }
    .metric-card strong { font-size: 58px; line-height: 1; font-family: var(--display); }
    .metric-card em { color: color-mix(in srgb, var(--slide-bg) 78%, transparent); font-style: normal; font-size: 20px; line-height: 1.25; }
    .stepper { display: grid; grid-template-columns: 220px 1fr; gap: 22px; min-height: 330px; }
    .step-buttons { display: grid; gap: 12px; align-content: start; }
    .step-buttons button { border: 0; padding: 18px; background: rgba(255,255,255,0.72); color: var(--ink); font: 900 22px var(--font); cursor: pointer; }
    .step-buttons button.active { background: var(--accent); color: white; }
    .step-panels article { display: none; height: 100%; padding: 34px; background: rgba(255,255,255,0.78); border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent); }
    .step-panels article.active { display: grid; align-content: center; }
    .step-panels b { font-size: 44px; line-height: 1.05; font-family: var(--display); }
    .step-panels p { margin: 18px 0 0; font-size: 28px; line-height: 1.3; color: var(--muted); }
    .detail-module { display: grid; grid-template-columns: 280px 1fr; gap: 22px; min-height: 340px; }
    .detail-triggers { display: grid; gap: 12px; align-content: start; }
    .detail-trigger { border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent); padding: 16px; background: rgba(255,255,255,0.66); color: var(--ink); text-align: left; cursor: pointer; display: grid; gap: 8px; }
    .detail-trigger span { color: var(--accent); font: 900 16px var(--font); }
    .detail-trigger b { font: 900 22px/1.08 var(--font); }
    .detail-trigger.active { background: var(--ink); color: var(--slide-bg); transform: translateX(8px); }
    .detail-panels { min-height: 340px; }
    .detail-panel { display: none; height: 100%; padding: 34px; background: color-mix(in srgb, var(--accent-2) 12%, white); border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent); align-content: center; }
    .detail-panel.active { display: grid; }
    .detail-panel small { color: var(--accent); text-transform: uppercase; font-size: 18px; font-weight: 900; }
    .detail-panel b { margin-top: 16px; font-size: 44px; line-height: 1.05; font-family: var(--display); }
    .detail-panel p { margin: 20px 0 0; color: var(--muted); font-size: 28px; line-height: 1.3; }
    .before-after { position: relative; min-height: 390px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent); background: rgba(255,255,255,0.72); }
    .ba-card { position: absolute; inset: 0; padding: 38px; display: grid; align-content: center; gap: 16px; }
    .ba-before { background: color-mix(in srgb, var(--ink) 9%, white); clip-path: inset(0 calc(100% - var(--split)) 0 0); }
    .ba-after { background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, white), color-mix(in srgb, var(--accent-2) 16%, white)); clip-path: inset(0 0 0 var(--split)); }
    .ba-card small { color: var(--accent); text-transform: uppercase; font-size: 18px; font-weight: 900; }
    .ba-card b { font-family: var(--display); font-size: 50px; line-height: 1; }
    .ba-card p { max-width: 560px; margin: 0; color: var(--muted); font-size: 27px; line-height: 1.28; }
    .before-after input { position: absolute; inset: 0; z-index: 4; width: 100%; height: 100%; opacity: 0; cursor: ew-resize; }
    .ba-handle { position: absolute; z-index: 3; top: 0; bottom: 0; left: var(--split); width: 4px; background: var(--ink); box-shadow: 0 0 0 8px color-mix(in srgb, var(--slide-bg) 80%, transparent); }
    .ba-handle::after { content: "< >"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 70px; height: 70px; border-radius: 50%; display: grid; place-items: center; background: var(--ink); color: var(--slide-bg); font: 900 18px var(--font); }
    .segment-module { display: grid; gap: 18px; min-height: 330px; }
    .segment-tabs, .chart-tabs { display: flex; flex-wrap: wrap; gap: 10px; }
    .segment-tabs button, .chart-tabs button { border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent); padding: 14px 18px; background: rgba(255,255,255,0.66); color: var(--ink); font: 900 18px var(--font); cursor: pointer; }
    .segment-tabs button.active, .chart-tabs button.active { background: var(--accent); color: white; border-color: var(--accent); }
    .segment-panels article { display: none; min-height: 250px; padding: 32px; background: rgba(255,255,255,0.78); border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent); align-content: center; }
    .segment-panels article.active { display: grid; }
    .segment-panels b { font-family: var(--display); font-size: 48px; line-height: 1.02; }
    .segment-panels p { margin: 18px 0 0; color: var(--muted); font-size: 28px; line-height: 1.3; }
    .reveal-stack { display: grid; gap: 14px; }
    .reveal-item { padding: 18px 22px; background: rgba(255,255,255,0.72); border-left: 8px solid var(--accent-3); color: var(--ink); font-size: 24px; line-height: 1.22; font-weight: 800; opacity: 0; transform: translateY(12px); transition: opacity 260ms ease, transform 260ms ease; }
    .slide.active .reveal-item.revealed { opacity: 1; transform: translateY(0); }
    .bar-chart { display: grid; gap: 18px; padding: 32px; background: rgba(255,255,255,0.78); }
    .bar-row { display: grid; grid-template-columns: 210px 1fr 64px; gap: 18px; align-items: center; font-size: 22px; font-weight: 800; }
    .bar-row div { height: 28px; background: color-mix(in srgb, var(--ink) 10%, transparent); }
    .bar-row i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
    .chart-toggle { display: grid; gap: 16px; padding: 28px; background: rgba(255,255,255,0.78); }
    .chart-toggle-panels article { display: none; gap: 18px; }
    .chart-toggle-panels article.active { display: grid; }
    .dataset-bars { display: grid; gap: 16px; }
    .chart-toggle-panels p { margin: 0; color: var(--muted); font-size: 24px; line-height: 1.28; font-weight: 750; }
    .speaker-note { position: absolute; z-index: 2; left: 72px; right: 72px; bottom: 48px; color: var(--muted); font-size: 20px; }
    .empty-visual { min-height: 420px; display: grid; place-items: center; border: 1px dashed color-mix(in srgb, var(--ink) 18%, transparent); color: var(--muted); font-size: 28px; font-weight: 800; }
    [data-layout="hero"] .slide-layout, [data-layout="closing"] .slide-layout { grid-template-columns: 1fr; align-content: center; }
    [data-layout="hero"] .copy-block h1, [data-layout="closing"] .copy-block h1 { max-width: 1320px; font-size: 132px; }
    [data-layout="hero"] .visual-block, [data-layout="closing"] .visual-block { grid-template-columns: 1fr 1fr; min-height: auto; }
    .deck-controls { position: fixed; right: 22px; bottom: 18px; z-index: 20; display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: rgba(0,0,0,0.56); color: white; font: 700 13px var(--font); border-radius: 999px; }
    .deck-controls button { width: 30px; height: 30px; border: 0; border-radius: 50%; color: white; background: rgba(255,255,255,0.16); cursor: pointer; }
    .slide-agenda { position: fixed; right: 22px; top: 50%; transform: translateY(-50%); z-index: 22; display: grid; gap: 10px; }
    .agenda-dot { position: relative; width: 12px; height: 12px; border: 0; border-radius: 50%; background: rgba(255,255,255,0.48); cursor: pointer; }
    .agenda-dot.active { background: var(--accent); transform: scale(1.35); }
    .agenda-dot::after { content: attr(data-title); position: absolute; right: 20px; top: 50%; transform: translateY(-50%); width: max-content; max-width: 260px; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.74); color: white; font: 700 12px var(--font); opacity: 0; pointer-events: none; }
    .agenda-dot:hover::after { opacity: 1; }
    @media print { html, body { width: 1920px; height: auto; overflow: visible; background: #fff; } .deck-viewport, .deck-stage { position: static; transform: none !important; overflow: visible; } .slide { position: relative; display: block !important; visibility: visible !important; opacity: 1 !important; width: 1920px; height: 1080px; break-after: page; } .deck-controls { display: none !important; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.2s !important; } }
  </style>
</head>
<body>
  <div class="deck-viewport">
    <div class="deck-stage" id="deckStage">
      ${slides}
    </div>
  </div>
  <div class="deck-controls">
    <button type="button" id="prevSlide" aria-label="Previous slide">&lt;</button>
    <span id="pageCounter">1 / ${spec.slides.length}</span>
    <button type="button" id="nextSlide" aria-label="Next slide">&gt;</button>
  </div>
  <nav class="slide-agenda" aria-label="Slide agenda">
    ${spec.slides.map((slide, index) => `<button type="button" class="agenda-dot ${index === 0 ? 'active' : ''}" data-agenda="${index}" data-title="${escapeHtml(slide.title)}" aria-label="Go to slide ${index + 1}: ${escapeHtml(slide.title)}"></button>`).join('\n    ')}
  </nav>
  <script>
    const slides = Array.from(document.querySelectorAll('.slide'));
    const stage = document.getElementById('deckStage');
    const counter = document.getElementById('pageCounter');
    const agendaDots = Array.from(document.querySelectorAll('[data-agenda]'));
    let current = 0;
    let revealIndex = 0;
    function scaleStage() {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      stage.style.transform = 'scale(' + scale + ')';
      stage.style.left = ((window.innerWidth - 1920 * scale) / 2) + 'px';
      stage.style.top = ((window.innerHeight - 1080 * scale) / 2) + 'px';
    }
    function revealItemsFor(index) {
      return Array.from(slides[index]?.querySelectorAll('.reveal-item') || []);
    }
    function updateReveals() {
      revealItemsFor(current).forEach((item, index) => item.classList.toggle('revealed', index < revealIndex));
    }
    function advanceReveal() {
      const items = revealItemsFor(current);
      if (revealIndex < items.length) {
        revealIndex += 1;
        updateReveals();
        return true;
      }
      return false;
    }
    function show(index) {
      current = Math.max(0, Math.min(slides.length - 1, index));
      revealIndex = 0;
      slides.forEach((slide, i) => slide.classList.toggle('active', i === current));
      slides.forEach((slide, i) => slide.classList.toggle('visible', i === current));
      slides.forEach((slide, i) => {
        if (i !== current) slide.querySelectorAll('.reveal-item').forEach((item) => item.classList.remove('revealed'));
      });
      agendaDots.forEach((dot, i) => dot.classList.toggle('active', i === current));
      counter.textContent = (current + 1) + ' / ' + slides.length;
      updateReveals();
    }
    document.getElementById('prevSlide').addEventListener('click', () => show(current - 1));
    document.getElementById('nextSlide').addEventListener('click', () => advanceReveal() || show(current + 1));
    agendaDots.forEach((dot) => dot.addEventListener('click', () => show(Number(dot.dataset.agenda) || 0)));
    window.addEventListener('resize', scaleStage);
    window.addEventListener('keydown', (event) => {
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        advanceReveal() || show(current + 1);
      }
      if (['ArrowLeft', 'PageUp'].includes(event.key)) show(current - 1);
    });
    document.querySelectorAll('.stepper').forEach((stepper) => {
      const buttons = Array.from(stepper.querySelectorAll('[data-step]'));
      const panels = Array.from(stepper.querySelectorAll('[data-panel]'));
      buttons.forEach((button) => button.addEventListener('click', () => {
        const active = button.dataset.step;
        buttons.forEach((item) => item.classList.toggle('active', item.dataset.step === active));
        panels.forEach((item) => item.classList.toggle('active', item.dataset.panel === active));
      }));
    });
    document.querySelectorAll('.detail-module').forEach((module) => {
      const triggers = Array.from(module.querySelectorAll('[data-detail]'));
      const panels = Array.from(module.querySelectorAll('[data-detail-panel]'));
      triggers.forEach((trigger) => trigger.addEventListener('click', () => {
        const active = trigger.dataset.detail;
        triggers.forEach((item) => item.classList.toggle('active', item.dataset.detail === active));
        panels.forEach((item) => item.classList.toggle('active', item.dataset.detailPanel === active));
      }));
    });
    document.querySelectorAll('.before-after').forEach((module) => {
      const input = module.querySelector('input[type="range"]');
      if (!input) return;
      const update = () => module.style.setProperty('--split', input.value + '%');
      input.addEventListener('input', update);
      update();
    });
    document.querySelectorAll('.segment-module').forEach((module) => {
      const tabs = Array.from(module.querySelectorAll('[data-segment]'));
      const panels = Array.from(module.querySelectorAll('[data-segment-panel]'));
      tabs.forEach((tab) => tab.addEventListener('click', () => {
        const active = tab.dataset.segment;
        tabs.forEach((item) => item.classList.toggle('active', item.dataset.segment === active));
        panels.forEach((item) => item.classList.toggle('active', item.dataset.segmentPanel === active));
      }));
    });
    document.querySelectorAll('.chart-toggle').forEach((module) => {
      const tabs = Array.from(module.querySelectorAll('[data-chart-dataset]'));
      const panels = Array.from(module.querySelectorAll('[data-chart-panel]'));
      tabs.forEach((tab) => tab.addEventListener('click', () => {
        const active = tab.dataset.chartDataset;
        tabs.forEach((item) => item.classList.toggle('active', item.dataset.chartDataset === active));
        panels.forEach((item) => item.classList.toggle('active', item.dataset.chartPanel === active));
      }));
    });
    scaleStage();
    show(0);
  </script>
</body>
</html>`;
}

function buildEditPrompt({ deck, currentHtml, instruction, currentPage, targetContext = '' }) {
  const compactHtml = currentHtml.length > 90000 ? currentHtml.slice(0, 90000) : currentHtml;
  const recentMessages = (deck.messages || []).slice(-10).map((message) => `${message.role}: ${message.text}`).join('\n');
  const comments = (deck.comments || []).slice(-10).map((comment) => {
    const status = comment.status || 'open';
    const selector = comment.selector ? ` selector=${comment.selector}` : '';
    const text = comment.elementText ? ` elementText="${comment.elementText.slice(0, 160)}"` : '';
    return `Slide ${comment.page} [${status}]${selector}${text}: ${comment.note}`;
  }).join('\n');
  return {
    system: `You are Slide Studio's HTML slide editing engine. Return only one complete updated HTML document.

Rules:
- Preserve the existing fixed 1920x1080 deck-stage architecture.
- Preserve the current visual template unless the user explicitly asks for a style change.
- Apply the requested change directly to the HTML.
- If the user asks for a local/current-slide change, primarily edit slide ${currentPage || 1}.
- Keep all CSS/JS inline and keep every slide as <section class="slide">.
- Do not remove keyboard/touch navigation or the page counter.
- Preserve existing interactive modules, chart toggles, walkthrough steppers, hotspot notes, and flow selectors unless the user explicitly asks to remove them.
- No markdown fences or commentary.`,
    user: `Current user instruction:
${instruction}

Current page: ${currentPage || 1}

Target context:
${targetContext || 'None'}

Recent chat:
${recentMessages || 'None'}

Annotations:
${comments || 'None'}

Current HTML:
${compactHtml}

Return the complete updated HTML file.`
  };
}

function buildPatchPrompt({ deck, currentHtml, instruction, currentPage, targetContext = '' }) {
  const slideRegex = new RegExp(`<section\\b[^>]*class=["'][^"']*\\bslide\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/section>`, 'gi');
  const slides = currentHtml.match(slideRegex) || [];
  const slideHtml = slides[Math.max(0, Math.min(slides.length - 1, (Number(currentPage) || 1) - 1))] || currentHtml.slice(0, 35000);
  const recentMessages = (deck.messages || []).slice(-8).map((message) => `${message.role}: ${message.text}`).join('\n');
  return {
    system: `You are Slide Studio's precise HTML patch engine.

Return ONLY valid JSON. No markdown fences, no explanation.

JSON schema:
{
  "summary": "short user-facing summary",
  "edits": [
    { "search": "exact substring copied from CURRENT HTML", "replace": "replacement substring" }
  ]
}

Rules:
- Prefer 1-4 exact search/replace edits.
- The search string must be copied exactly from the current HTML below.
- Replace enough surrounding HTML to make the change reliable.
- For text-only requests, search and replace the smallest exact text/HTML span.
- For layout/style requests, edit the current slide section and/or inline CSS with exact search/replace.
- Preserve fixed 1920x1080 stage rules and every <section class="slide">.
- Preserve existing JavaScript interactions, chart states, walkthrough controls, flow selectors, and navigation runtime unless the instruction explicitly targets them.
- Do not return a complete HTML document unless JSON patching is impossible.`,
    user: `Instruction:
${instruction}

Current page: ${currentPage || 1}

Target context:
${targetContext || 'None'}

Recent chat:
${recentMessages || 'None'}

CURRENT SLIDE HTML:
${slideHtml}

If CSS changes are needed, use exact search/replace against snippets visible in the slide or obvious reusable class names. Return JSON only.`
  };
}

function parseJsonObject(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI did not return JSON patch instructions.');
  return JSON.parse(text.slice(start, end + 1));
}

function applySearchReplaceEdits(currentHtml, patch) {
  if (!patch || !Array.isArray(patch.edits) || !patch.edits.length) {
    throw new Error('AI returned an empty patch.');
  }
  let html = currentHtml;
  const applied = [];
  for (const edit of patch.edits) {
    const search = String(edit.search || '');
    const replace = String(edit.replace || '');
    if (!search) throw new Error('AI patch contained an empty search string.');
    const index = html.indexOf(search);
    if (index === -1) {
      throw new Error(`AI patch search text was not found: ${search.slice(0, 120)}`);
    }
    html = `${html.slice(0, index)}${replace}${html.slice(index + search.length)}`;
    applied.push({ searchLength: search.length, replaceLength: replace.length });
  }
  extractHtml(html);
  return { html, summary: patch.summary || 'Applied the requested edit.', applied };
}

async function generateDeckHtml({ prompt, template, artifactType, modelConfig, onProgress = async () => {} }) {
  await onProgress('Loading template assets', `Reading a compact ${template.name} design recipe.`);
  const designMd = readTextFile(path.join(TEMPLATE_DIR, template.slug, 'design.md'), FALLBACK_DESIGN_MD);
  await onProgress('Building artifact brief', `Combining your request, ${artifactType.name}, and a compact visual recipe.`);
  const generationPrompt = buildGenerationPrompt({ prompt, template, artifactType, designMd });
  await onProgress('Calling the model', `Requesting a structured deck design from ${modelConfig.provider} / ${modelConfig.model}.`, 'active');
  const raw = await callChatCompletions({
    modelConfig,
    maxTokens: GENERATION_MAX_TOKENS,
    messages: [
      { role: 'system', content: generationPrompt.system },
      { role: 'user', content: generationPrompt.user }
    ]
  });
  await onProgress('Rendering HTML artifact', 'Composing the structured design into a complete fixed-stage HTML deck.');
  const spec = normalizeDeckSpec(parseJsonObject(raw), prompt, artifactType);
  return extractHtml(renderDeckHtmlFromSpec(spec, template, artifactType));
}

async function editDeckHtml({ deck, instruction, currentPage, modelConfig }) {
  if (!deck.filePath || !fs.existsSync(deck.filePath)) {
    throw new Error('Generated HTML file is missing. Regenerate this deck first.');
  }
  const currentHtml = fs.readFileSync(deck.filePath, 'utf8');
  const patchPrompt = buildPatchPrompt({ deck, currentHtml, instruction, currentPage, targetContext: deck.targetContext || '' });
  try {
    const rawPatch = await callChatCompletions({
      modelConfig,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: patchPrompt.system },
        { role: 'user', content: patchPrompt.user }
      ]
    });
    const patch = parseJsonObject(rawPatch);
    return applySearchReplaceEdits(currentHtml, patch).html;
  } catch (patchError) {
    logEvent('error', 'Patch edit failed; falling back to full HTML edit', { deckId: deck.id, message: patchError.message });
    const editPrompt = buildEditPrompt({ deck, currentHtml, instruction, currentPage, targetContext: deck.targetContext || '' });
    try {
      const raw = await callChatCompletions({
        modelConfig,
        maxTokens: EDIT_MAX_TOKENS,
        messages: [
          { role: 'system', content: editPrompt.system },
          { role: 'user', content: editPrompt.user }
        ]
      });
      return extractHtml(raw);
    } catch (fullError) {
      throw new Error(`AI edit failed. Patch path: ${patchError.message}. Full HTML path: ${fullError.message}`);
    }
  }
}

function saveDeckVersion(deck, label = 'Before edit') {
  if (!deck.filePath || !fs.existsSync(deck.filePath)) return null;
  const versionId = crypto.randomUUID();
  const versionDir = path.join(path.dirname(deck.filePath), `${deck.id}-versions`);
  fs.mkdirSync(versionDir, { recursive: true });
  const versionPath = path.join(versionDir, `${versionId}.html`);
  fs.copyFileSync(deck.filePath, versionPath);
  deck.versions ||= [];
  const version = {
    id: versionId,
    label,
    filePath: versionPath,
    createdAt: new Date().toISOString()
  };
  deck.versions.push(version);
  deck.versions = deck.versions.slice(-20);
  return version;
}

function seedDemoData() {
  if (String(process.env.SEED_DEMO || 'true').toLowerCase() === 'false') return;
  const demoEmail = String(process.env.DEMO_EMAIL || 'demo@slidestudio.local').trim().toLowerCase();
  const demoPassword = String(process.env.DEMO_PASSWORD || 'demo1234');
  const now = new Date().toISOString();
  const db = readDb();
  let changed = false;
  let demoUser = db.users.find((user) => user.email === demoEmail);
  if (!demoUser) {
    demoUser = {
      id: 'demo-user',
      name: 'Demo User',
      email: demoEmail,
      passwordHash: hashPassword(demoPassword),
      createdAt: now,
      emailVerifiedAt: now,
      credits: 999,
      plan: 'paid',
      isGuest: false
    };
    db.users.push(demoUser);
    changed = true;
  } else {
    demoUser.name ||= 'Demo User';
    demoUser.passwordHash ||= hashPassword(demoPassword);
    demoUser.emailVerifiedAt ||= now;
    demoUser.credits = Math.max(Number(demoUser.credits || 0), 999);
    demoUser.plan = 'paid';
    demoUser.isGuest = false;
    changed = true;
  }

  const sampleDecks = [
    {
      id: 'demo-ai-creation-tool',
      title: 'AI Creation Tool Launch',
      prompt: 'Create a product launch deck for an AI creation tool.',
      templateId: 'sakura-chroma',
      templateSlug: 'sakura-chroma',
      source: path.join(ROOT, 'ai-creation-sakura-chroma.html'),
      message: 'Demo deck seeded for portfolio reviewers.'
    },
    {
      id: 'demo-ai-notes-launch',
      title: 'AI Notes Product Narrative',
      prompt: 'Create a polished deck for an AI notes product launch.',
      templateId: 'soft-editorial',
      templateSlug: 'soft-editorial',
      source: path.join(ROOT, 'ai-notes-launch.html'),
      message: 'Second sample project showing another visual direction.'
    }
  ];
  const userDir = path.join(GENERATED_DIR, demoUser.id);
  fs.mkdirSync(userDir, { recursive: true });
  for (const sample of sampleDecks) {
    if (!fs.existsSync(sample.source)) continue;
    const filePath = path.join(userDir, `${sample.id}.html`);
    if (!fs.existsSync(filePath)) fs.copyFileSync(sample.source, filePath);
    let deck = db.decks.find((item) => item.id === sample.id);
    if (!deck) {
      deck = {
        id: sample.id,
        userId: demoUser.id,
        prompt: sample.prompt,
        templateId: sample.templateId,
        templateSlug: sample.templateSlug,
        title: sample.title,
        deckPath: `/generated/${sample.id}.html`,
        filePath,
        originalHtmlPath: filePath,
        status: 'complete',
        currentPage: 1,
        targetContext: '',
        error: '',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        messages: [
          { id: `${sample.id}-msg-user`, role: 'user', text: sample.prompt, createdAt: now },
          { id: `${sample.id}-msg-assistant`, role: 'assistant', text: sample.message, createdAt: now }
        ],
        comments: [],
        versions: [
          { id: `${sample.id}-v1`, label: 'Initial demo version', filePath, createdAt: now }
        ]
      };
      db.decks.unshift(deck);
      changed = true;
    } else {
      deck.userId = demoUser.id;
      deck.deckPath = `/generated/${sample.id}.html`;
      deck.filePath = filePath;
      deck.status = 'complete';
      deck.messages ||= [];
      deck.comments ||= [];
      deck.versions ||= [];
      if (!deck.versions.length) deck.versions.push({ id: `${sample.id}-v1`, label: 'Initial demo version', filePath, createdAt: now });
      changed = true;
    }
  }
  if (changed) writeDb(db);
}

async function runDeckGeneration({ db, user, deck, template }) {
  const modelConfig = getServerModelConfig();
  const targetContext = parseTargetContext(deck.targetContext);
  const artifactType = getArtifactType(targetContext.artifactTypeId);
  addDeckProgress(db, deck, 'Checking model configuration', 'Confirming the server has an OpenAI-compatible model configured.');
  const html = await generateDeckHtml({
    prompt: deck.prompt,
    template,
    artifactType,
    modelConfig,
    onProgress: async (title, detail, status) => addDeckProgress(db, deck, title, detail, status)
  });
  addDeckProgress(db, deck, 'Writing presentation file', 'Saving the generated HTML artifact into the project workspace.');
  const userDir = path.join(GENERATED_DIR, user.id);
  fs.mkdirSync(userDir, { recursive: true });
  const filePath = path.join(userDir, `${deck.id}.html`);
  fs.writeFileSync(filePath, html);
  deck.status = 'complete';
  deck.deckPath = `/generated/${deck.id}.html`;
  deck.filePath = filePath;
  deck.completedAt = new Date().toISOString();
  deck.updatedAt = new Date().toISOString();
  deck.error = '';
  deck.messages ||= [];
  deck.comments ||= [];
  deck.versions ||= [];
  if (!deck.originalHtmlPath) {
    addDeckProgress(db, deck, 'Saving original version', 'Creating the first restorable version for later edits.');
    const originalPath = path.join(userDir, `${deck.id}.original.html`);
    fs.copyFileSync(filePath, originalPath);
    deck.originalHtmlPath = originalPath;
  }
  if (!deck.messages.some((message) => message.role === 'assistant')) {
    deck.messages.push(
      { id: crypto.randomUUID(), role: 'assistant', text: `Generated a real HTML ${artifactType.name.toLowerCase()} artifact with ${template.name}.`, createdAt: deck.updatedAt }
    );
  }
  addDeckProgress(db, deck, 'Ready to deliver', 'The artifact is complete. Open it to edit, regenerate, or export PDF.');
  writeDb(db);
  return deck;
}

function startDeckGenerationJob(deckId) {
  if (!deckId || activeGenerationJobs.has(deckId)) return;
  activeGenerationJobs.add(deckId);
  setTimeout(async () => {
    try {
      const db = readDb();
      const deck = db.decks.find((item) => item.id === deckId);
      if (!deck) return;
      const user = db.users.find((item) => item.id === deck.userId);
      if (!user) {
        deck.status = 'failed';
        deck.error = 'The user for this deck no longer exists.';
        deck.completedAt = new Date().toISOString();
        writeDb(db);
        return;
      }
      const template = templates.find((item) => item.id === deck.templateId) || templates[0];
      await runDeckGeneration({ db, user, deck, template });
      logEvent('info', 'Deck generated in background', { userId: user.id, templateId: template.id, deckId: deck.id });
    } catch (error) {
      try {
        const db = readDb();
        const deck = db.decks.find((item) => item.id === deckId);
        if (deck) {
          addDeckProgress(db, deck, 'Generation failed', error.message || 'Generation failed.', 'failed');
          deck.status = 'failed';
          deck.error = error.message || 'Generation failed.';
          deck.completedAt = new Date().toISOString();
          deck.updatedAt = deck.completedAt;
          writeDb(db);
          logEvent('error', 'Background deck generation failed', { userId: deck.userId, templateId: deck.templateId, deckId, message: deck.error });
        }
      } catch (persistError) {
        logEvent('error', 'Could not persist background generation failure', { deckId, message: persistError.message });
      }
    } finally {
      activeGenerationJobs.delete(deckId);
    }
  }, 0);
}

function createApiRouter() {
  const router = express.Router();

  router.use(express.json({ limit: '1mb' }));

  router.get('/health', (req, res) => {
    res.json({ ok: true, app: 'Slide Studio', time: new Date().toISOString() });
  });

  router.get('/templates', (req, res) => {
    res.json({ templates, artifactTypes });
  });

  router.get('/me', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    res.json({ user: publicUser(user), quota: usageSummaryForUser(db, user, req) });
  });

  router.post('/signup', async (req, res) => {
    const db = readDb();
    const currentUser = getUser(req, db);
    const pendingGuestUserId = currentUser?.isGuest ? currentUser.id : '';
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim() || email.split('@')[0];
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (db.users.some((item) => item.email === email)) return res.status(409).json({ error: 'Email already exists.' });

    for (const entry of db.signupVerificationTokens || []) {
      if (entry.email === email && !entry.usedAt) entry.usedAt = new Date().toISOString();
    }
    const verificationLink = createSignupVerification(db, { email, name, pendingGuestUserId });
    writeDb(db);
    const verificationEmail = await sendVerificationEmail({ email }, verificationLink).catch((error) => {
      logEvent('error', 'Verification email delivery failed', { email, message: error.message });
      return createVerificationEmailPreview({ email }, verificationLink);
    });
    logEvent('info', 'Signup verification link created', { email, verificationLink, delivery: verificationEmail.delivery, pendingGuestUserId });
    res.json({
      requiresVerification: true,
      verificationLink,
      verificationEmail
    });
  });

  router.get('/signup-token', (req, res) => {
    const db = readDb();
    const token = String(req.query.token || '').trim();
    const entry = (db.signupVerificationTokens || []).find((item) => item.token === token);
    if (!entry || entry.usedAt) return res.status(400).json({ error: 'Signup verification link is invalid or already used.' });
    if (new Date(entry.expiresAt).getTime() < Date.now()) return res.status(400).json({ error: 'Signup verification link has expired.' });
    if (db.users.some((item) => item.email === entry.email)) return res.status(409).json({ error: 'Email already exists. Please log in.' });
    res.json({ email: entry.email, name: entry.name || entry.email.split('@')[0] });
  });

  router.post('/signup/complete', (req, res) => {
    const db = readDb();
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const entry = (db.signupVerificationTokens || []).find((item) => item.token === token);
    if (!entry || entry.usedAt) return res.status(400).json({ error: 'Signup verification link is invalid or already used.' });
    if (new Date(entry.expiresAt).getTime() < Date.now()) return res.status(400).json({ error: 'Signup verification link has expired.' });
    if (password.length < 6) return res.status(400).json({ error: 'A 6+ character password is required.' });
    if (db.users.some((item) => item.email === entry.email)) return res.status(409).json({ error: 'Email already exists. Please log in.' });

    const now = new Date().toISOString();
    const newUser = {
      id: crypto.randomUUID(),
      name: name || entry.name || entry.email.split('@')[0],
      email: entry.email,
      passwordHash: hashPassword(password),
      createdAt: now,
      emailVerifiedAt: now,
      credits: QUOTAS.verifiedSignupCredits,
      plan: 'free',
      isGuest: false
    };
    db.users.push(newUser);
    entry.usedAt = now;
    const migration = mergeGuestProjectsIntoUser(db, entry.pendingGuestUserId, newUser);
    const sessionToken = crypto.randomBytes(32).toString('hex');
    db.sessions[sessionToken] = { userId: newUser.id, createdAt: now };
    writeDb(db);
    setSessionCookie(res, sessionToken);
    logEvent('info', 'Signup completed after email verification', { email: newUser.email, migratedDecks: migration.decks });
    res.json({
      user: publicUser(newUser),
      quota: usageSummaryForUser(db, newUser, req),
      migratedDecks: migration.decks
    });
  });

  router.get('/verify-email', (req, res) => {
    const db = readDb();
    const token = String(req.query.token || '').trim();
    const entry = (db.verificationTokens || []).find((item) => item.token === token);
    if (!entry || entry.usedAt) return res.status(400).send('Verification link is invalid or already used.');
    if (new Date(entry.expiresAt).getTime() < Date.now()) return res.status(400).send('Verification link has expired.');
    const user = db.users.find((item) => item.id === entry.userId);
    if (!user) return res.status(404).send('User not found.');
    entry.usedAt = new Date().toISOString();
    let migratedDecks = 0;
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = entry.usedAt;
      user.credits = Number(user.credits || 0) + QUOTAS.verifiedSignupCredits;
      migratedDecks = mergeGuestProjectsIntoUser(db, entry.pendingGuestUserId, user).decks;
    }
    writeDb(db);
    logEvent('info', 'Email verified', { email: user.email, credits: user.credits, migratedDecks });
    const verifiedReturnUrl = `${APP_BASE_URL}?verified=1&migrated=${encodeURIComponent(String(migratedDecks))}`;
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email verified</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #25231f; background: #f7f5ef; }
    main { width: min(440px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #e8e1d5; border-radius: 8px; box-shadow: 0 20px 60px rgba(42, 42, 35, 0.1); }
    h1 { margin: 0 0 10px; font-size: 26px; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #625f58; line-height: 1.5; }
    a { display: inline-flex; align-items: center; height: 42px; padding: 0 16px; color: #fff; background: #17614f; border-radius: 8px; font-weight: 800; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <h1>Email verified</h1>
    <p>${escapeHtml(QUOTAS.verifiedSignupCredits)} credits have been added to ${escapeHtml(user.email)}.${migratedDecks ? ` ${escapeHtml(migratedDecks)} trial project${migratedDecks === 1 ? '' : 's'} have been saved to this account.` : ''} You can return to Slide Studio and start generating.</p>
    <a href="${escapeHtml(verifiedReturnUrl)}">Return to Slide Studio</a>
  </main>
  <script>setTimeout(() => { window.location.href = ${JSON.stringify(verifiedReturnUrl)}; }, 2200);</script>
</body>
</html>`);
  });

  router.post('/resend-verification', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user || user.isGuest) return res.status(401).json({ error: 'Please log in before verifying email.' });
    if (user.emailVerifiedAt) return res.json({ user: publicUser(user), alreadyVerified: true });
    const verificationLink = createEmailVerification(db, user);
    writeDb(db);
    const verificationEmail = await sendVerificationEmail(user, verificationLink).catch((error) => {
      logEvent('error', 'Verification email resend delivery failed', { email: user.email, message: error.message });
      return createVerificationEmailPreview(user, verificationLink);
    });
    logEvent('info', 'Verification email resent', { email: user.email, verificationLink, delivery: verificationEmail.delivery });
    res.json({
      user: publicUser(user),
      requiresVerification: true,
      verificationLink,
      verificationEmail
    });
  });

  router.post('/login', async (req, res) => {
    const db = readDb();
    const currentUser = getUser(req, db);
    const pendingGuestUserId = currentUser?.isGuest ? currentUser.id : '';
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const found = db.users.find((item) => item.email === email);
    if (!found || !verifyPassword(password, found.passwordHash)) {
      logEvent('error', 'Login failed', { email });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = { userId: found.id, createdAt: new Date().toISOString() };
    const migration = found.emailVerifiedAt ? mergeGuestProjectsIntoUser(db, pendingGuestUserId, found) : { decks: 0 };
    const verificationLink = found.emailVerifiedAt ? '' : createEmailVerification(db, found, { pendingGuestUserId });
    writeDb(db);
    setSessionCookie(res, token);
    const verificationEmail = verificationLink
      ? await sendVerificationEmail(found, verificationLink).catch((error) => {
        logEvent('error', 'Login verification email delivery failed', { email, message: error.message });
        return createVerificationEmailPreview(found, verificationLink);
      })
      : null;
    logEvent('info', 'User logged in', { email, delivery: verificationEmail?.delivery || '', pendingGuestUserId, migratedDecks: migration.decks });
    res.json({
      user: publicUser(found),
      requiresVerification: Boolean(verificationLink),
      verificationLink,
      verificationEmail,
      migratedDecks: migration.decks
    });
  });

  router.post('/logout', (req, res) => {
    const db = readDb();
    const token = parseCookies(req).session;
    if (token) delete db.sessions[token];
    writeDb(db);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  router.post('/generate', async (req, res) => {
    const db = readDb();
    let user = getUser(req, db);
    const requestedTemplate = templates.find((item) => item.id === req.body.templateId) || templates[0];
    const template = (!user || user.isGuest) && !BASIC_TRIAL_TEMPLATE_IDS.has(requestedTemplate.id)
      ? templates.find((item) => BASIC_TRIAL_TEMPLATE_IDS.has(item.id)) || requestedTemplate
      : requestedTemplate;
    const artifactType = getArtifactType(req.body.artifactTypeId);
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) {
      logEvent('error', 'Generate failed: empty prompt', { userId: user?.id || 'guest' });
      return res.status(400).json({ error: 'Prompt is required.' });
    }
    if (!user) user = createGuestUserAndSession(req, res, db);
    const allowance = ensureGenerationAllowance({ req, res, db, user, template });
    if (allowance.error) return res.status(allowance.status || 429).json({ error: allowance.error, user: publicUser(user), quota: usageSummaryForUser(db, user, req) });
    allowance.spend();

    const deck = {
      id: crypto.randomUUID(),
      userId: user.id,
      prompt: user.isGuest ? `${prompt}\n\nTrial constraint: create a concise basic presentation artifact with no more than 5 slides.` : prompt,
      templateId: template.id,
      templateSlug: template.slug,
      title: prompt.slice(0, 56),
      deckPath: '',
      status: 'generating',
      targetContext: JSON.stringify({ artifactTypeId: artifactType.id }),
      createdAt: new Date().toISOString(),
      completedAt: '',
      error: '',
      comments: [],
      messages: [
        { id: crypto.randomUUID(), role: 'user', text: prompt, createdAt: new Date().toISOString() }
      ]
    };
    db.decks.unshift(deck);
    addDeckProgress(db, deck, 'Queued generation task', `Created a ${artifactType.name.toLowerCase()} artifact job and handed it to the server worker.`);
    writeDb(db);
    logEvent('info', 'Deck generation started', { userId: user.id, templateId: template.id, artifactTypeId: artifactType.id, deckId: deck.id });
    if (req.body.async) {
      startDeckGenerationJob(deck.id);
      return res.status(202).json({ deck: publicDeck(deck), user: publicUser(user), quota: usageSummaryForUser(db, user, req) });
    }
    try {
      await runDeckGeneration({ db, user, deck, template });
      logEvent('info', 'Deck generated', { userId: user.id, templateId: template.id, deckId: deck.id });
      return res.json({ deck: publicDeck(deck), user: publicUser(user), quota: usageSummaryForUser(db, user, req) });
    } catch (error) {
      deck.status = 'failed';
      deck.error = error.message || 'Generation failed.';
      deck.completedAt = new Date().toISOString();
      writeDb(db);
      logEvent('error', 'Deck generation failed', { userId: user.id, templateId: template.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/generate/:deckId/retry', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const template = templates.find((item) => item.id === deck.templateId) || templates[0];
    const allowance = ensureGenerationAllowance({ req, res, db, user, template });
    if (allowance.error) return res.status(allowance.status || 429).json({ error: allowance.error, deck: publicDeck(deck), quota: usageSummaryForUser(db, user, req) });
    allowance.spend();
    deck.status = 'generating';
    deck.error = '';
    deck.completedAt = '';
    deck.updatedAt = new Date().toISOString();
    deck.messages = (deck.messages || []).filter((message) => message.role !== 'progress');
    addDeckProgress(db, deck, 'Queued retry task', 'Restarted generation for this deck using the same prompt and template.');
    writeDb(db);
    logEvent('info', 'Deck retry started', { userId: user.id, templateId: template.id, deckId: deck.id });
    if (req.body.async) {
      startDeckGenerationJob(deck.id);
      return res.status(202).json({ deck: publicDeck(deck) });
    }
    try {
      await runDeckGeneration({ db, user, deck, template });
      logEvent('info', 'Deck retry generated', { userId: user.id, templateId: template.id, deckId: deck.id });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.status = 'failed';
      deck.error = error.message || 'Generation failed.';
      deck.completedAt = new Date().toISOString();
      writeDb(db);
      logEvent('error', 'Deck retry failed', { userId: user.id, templateId: template.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.get('/decks', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    res.json({ decks: db.decks.filter((deck) => deck.userId === user.id).map(publicDeck) });
  });

  router.get('/decks/:deckId', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    res.json({ deck: publicDeck(deck) });
  });

  router.get('/decks/:deckId/download/html', (req, res) => {
    const { deck, resolvedPath } = getAuthorizedDeck(req, res);
    if (!deck || !resolvedPath || res.headersSent) return;
    const filename = `${sanitizeFileName(deck.title)}.html`;
    logEvent('info', 'Deck HTML download started', { deckId: deck.id });
    res.download(resolvedPath, filename);
  });

  router.get('/decks/:deckId/export/pdf', async (req, res) => {
    const { deck, resolvedPath } = getAuthorizedDeck(req, res);
    if (!deck || !resolvedPath || res.headersSent) return;
    const chromePath = findChromeExecutable();
    if (!chromePath) {
      return res.status(500).json({ error: 'Chrome was not found on this machine, so PDF export is unavailable.' });
    }

    const exportId = crypto.randomUUID();
    const exportDir = path.join(os.tmpdir(), 'slide-studio-exports', exportId);
    fs.mkdirSync(exportDir, { recursive: true });
    const printablePath = path.join(exportDir, 'printable.html');
    const pdfPath = path.join(exportDir, `${sanitizeFileName(deck.title)}.pdf`);
    fs.writeFileSync(printablePath, buildPrintableHtml(fs.readFileSync(resolvedPath, 'utf8')));

    try {
      await execFileAsync(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--run-all-compositor-stages-before-draw',
        '--no-pdf-header-footer',
        `--user-data-dir=${path.join(exportDir, 'chrome-profile')}`,
        `--print-to-pdf=${pdfPath}`,
        `file://${printablePath}`
      ], { timeout: 60000 });
      if (!fs.existsSync(pdfPath)) throw new Error('Chrome did not create a PDF file.');
      logEvent('info', 'Deck PDF exported', { deckId: deck.id });
      res.download(pdfPath, `${sanitizeFileName(deck.title)}.pdf`, (error) => {
        fs.rm(exportDir, { recursive: true, force: true }, () => {});
        if (error) logEvent('error', 'PDF download failed', { deckId: deck.id, message: error.message });
      });
    } catch (error) {
      fs.rm(exportDir, { recursive: true, force: true }, () => {});
      logEvent('error', 'Deck PDF export failed', { deckId: deck.id, message: error.message, stderr: error.stderr });
      res.status(500).json({ error: `PDF export failed: ${error.message}` });
    }
  });

  router.post('/decks/:deckId/messages', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const instruction = String(req.body.text || '').trim();
    const currentPage = Number(req.body.currentPage || deck.currentPage || 1);
    if (!instruction) return res.status(400).json({ error: 'Message text is required.' });

    deck.messages ||= [];
    deck.messages.push({ id: crypto.randomUUID(), role: 'user', text: instruction, page: currentPage, createdAt: new Date().toISOString() });
    deck.status = 'editing';
    deck.currentPage = currentPage;
    saveDeckVersion(deck, `Before chat edit: ${instruction.slice(0, 48)}`);
    writeDb(db);

    try {
      const updatedHtml = await editDeckHtml({
        deck,
        instruction,
        currentPage,
        modelConfig: getServerModelConfig()
      });
      fs.writeFileSync(deck.filePath, updatedHtml);
      deck.status = 'complete';
      deck.updatedAt = new Date().toISOString();
      deck.error = '';
      deck.lastAppliedAt = deck.updatedAt;
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Applied the requested edit on slide ${currentPage}.`,
        page: currentPage,
        createdAt: deck.updatedAt
      });
      writeDb(db);
      logEvent('info', 'Deck edited from chat', { userId: user.id, deckId: deck.id, currentPage });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.status = 'complete';
      deck.error = error.message || 'Edit failed.';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Edit failed: ${deck.error}`,
        page: currentPage,
        createdAt: new Date().toISOString()
      });
      writeDb(db);
      logEvent('error', 'Deck edit failed', { userId: user.id, deckId: deck.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/decks/:deckId/undo', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    if (!deck.filePath || !fs.existsSync(deck.filePath)) return res.status(404).json({ error: 'Current HTML file is missing.' });
    deck.versions ||= [];
    const version = deck.versions.pop();
    if (!version || !version.filePath || !fs.existsSync(version.filePath)) {
      return res.status(400).json({ error: 'No previous version available.' });
    }
    fs.copyFileSync(version.filePath, deck.filePath);
    deck.updatedAt = new Date().toISOString();
    deck.status = 'complete';
    deck.error = '';
    deck.messages ||= [];
    deck.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      text: `Undid: ${version.label || 'previous edit'}.`,
      createdAt: deck.updatedAt
    });
    writeDb(db);
    logEvent('info', 'Deck undo applied', { userId: user.id, deckId: deck.id, versionId: version.id });
    res.json({ deck: publicDeck(deck) });
  });

  router.post('/comment', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.body.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const comment = {
      id: crypto.randomUUID(),
      page: Number(req.body.page || 1),
      note: String(req.body.note || ''),
      x: Number(req.body.x || 0),
      y: Number(req.body.y || 0),
      selector: String(req.body.selector || ''),
      elementText: String(req.body.elementText || ''),
      elementTag: String(req.body.elementTag || ''),
      elementRect: req.body.elementRect || null,
      status: 'open',
      createdAt: new Date().toISOString()
    };
    deck.comments.push(comment);
    deck.messages ||= [];
    deck.messages.push({ id: crypto.randomUUID(), role: 'user', text: `Annotation on slide ${comment.page}: ${comment.note}`, page: comment.page, createdAt: comment.createdAt });
    deck.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: 'Annotation saved. Applying it to the deck now.', page: comment.page, createdAt: new Date().toISOString() });
    writeDb(db);
    logEvent('info', 'Annotation added', { userId: user.id, deckId: deck.id });
    res.json({ deck: publicDeck(deck) });
  });

  router.post('/decks/:deckId/comments/:commentId/apply', async (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).json({ error: 'Login required.' });
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck) return res.status(404).json({ error: 'Deck not found.' });
    const comment = (deck.comments || []).find((item) => item.id === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Annotation not found.' });
    const instruction = String(req.body.text || comment.note || '').trim();
    if (!instruction) return res.status(400).json({ error: 'Annotation text is required.' });
    const currentPage = Number(comment.page || deck.currentPage || 1);
    const targetContext = [
      `Annotation id: ${comment.id}`,
      `Slide: ${currentPage}`,
      comment.selector ? `DOM selector: ${comment.selector}` : '',
      comment.elementTag ? `Element tag: ${comment.elementTag}` : '',
      comment.elementText ? `Element visible text: ${comment.elementText}` : '',
      comment.elementRect ? `Element rect: ${JSON.stringify(comment.elementRect)}` : '',
      `Annotation coordinates: ${comment.x}, ${comment.y}`,
      `Requested change: ${instruction}`
    ].filter(Boolean).join('\n');

    deck.messages ||= [];
    deck.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      text: `Apply annotation on slide ${currentPage}: ${instruction}`,
      page: currentPage,
      createdAt: new Date().toISOString()
    });
    deck.status = 'editing';
    deck.currentPage = currentPage;
    deck.targetContext = targetContext;
    saveDeckVersion(deck, `Before annotation: ${instruction.slice(0, 48)}`);
    writeDb(db);

    try {
      const updatedHtml = await editDeckHtml({
        deck,
        instruction: `Apply this annotation precisely: ${instruction}`,
        currentPage,
        modelConfig: getServerModelConfig()
      });
      fs.writeFileSync(deck.filePath, updatedHtml);
      comment.status = 'resolved';
      comment.resolvedAt = new Date().toISOString();
      deck.targetContext = '';
      deck.status = 'complete';
      deck.updatedAt = new Date().toISOString();
      deck.error = '';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Resolved annotation on slide ${currentPage}.`,
        page: currentPage,
        createdAt: deck.updatedAt
      });
      writeDb(db);
      logEvent('info', 'Annotation applied', { userId: user.id, deckId: deck.id, commentId: comment.id });
      return res.json({ deck: publicDeck(deck) });
    } catch (error) {
      deck.targetContext = '';
      deck.status = 'complete';
      deck.error = error.message || 'Annotation edit failed.';
      deck.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Annotation edit failed: ${deck.error}`,
        page: currentPage,
        createdAt: new Date().toISOString()
      });
      writeDb(db);
      logEvent('error', 'Annotation apply failed', { userId: user.id, deckId: deck.id, commentId: comment.id, message: deck.error });
      return res.status(500).json({ error: deck.error, deck: publicDeck(deck) });
    }
  });

  router.post('/logs', (req, res) => {
    const entry = logEvent(String(req.body.level || 'info'), String(req.body.message || 'Client event'), req.body.meta || {});
    res.json({ ok: true, entry });
  });

  router.use((err, req, res, next) => {
    logEvent('error', 'API error', { path: req.path, message: err.message });
    res.status(500).json({ error: 'Server error.' });
  });

  return router;
}

async function start() {
  ensureDb();
  seedDemoData();
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createApiRouter());
  app.get('/generated/:deckId.html', (req, res) => {
    const db = readDb();
    const user = getUser(req, db);
    if (!user) return res.status(401).send('Login required.');
    const deck = db.decks.find((item) => item.id === req.params.deckId && item.userId === user.id);
    if (!deck || deck.status !== 'complete' || !deck.filePath) return res.status(404).send('Deck not found.');
    const resolvedPath = path.resolve(deck.filePath);
    if (!resolvedPath.startsWith(path.resolve(GENERATED_DIR))) return res.status(403).send('Forbidden.');
    res.sendFile(resolvedPath);
  });
  app.get('/ai-creation-sakura-chroma.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-creation-sakura-chroma.html')));
  app.get('/ai-creation-sakura-chroma-edited.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-creation-sakura-chroma-edited.html')));
  app.get('/ai-notes-launch.html', (req, res) => res.sendFile(path.join(ROOT, 'ai-notes-launch.html')));
  app.get('/product.html', (req, res) => res.sendFile(path.join(PUBLIC, 'product.html')));

  if (isProduction) {
    const DIST = path.join(ROOT, 'dist');
    app.use(express.static(DIST));
    app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: PUBLIC,
      appType: 'spa',
      server: { middlewareMode: true }
    });
    app.use(vite.middlewares);
  }

  app.use((err, req, res, next) => {
    logEvent('error', 'Server error', { path: req.path, message: err.message });
    res.status(500).json({ error: 'Server error.' });
  });

  app.listen(PORT, () => {
    console.log(`Slide Studio running at http://127.0.0.1:${PORT}`);
  });
}

start().catch((error) => {
  logEvent('error', 'Failed to start server', { message: error.message, stack: error.stack });
  process.exit(1);
});
