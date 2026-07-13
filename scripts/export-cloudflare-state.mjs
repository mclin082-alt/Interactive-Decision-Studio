import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.resolve(process.env.SLIDE_STUDIO_DATA_DIR || path.join(ROOT, '.local-data'));
const DB_FILE = path.join(DATA_DIR, 'slide-studio.sqlite');
const OUT_DIR = path.join(ROOT, 'cloudflare');
const STATE_SQL = path.join(OUT_DIR, 'app-state.sql');
const R2_MANIFEST = path.join(OUT_DIR, 'r2-upload-manifest.json');

if (!fs.existsSync(DB_FILE)) {
  throw new Error(`SQLite database not found: ${DB_FILE}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sqlite = new DatabaseSync(DB_FILE, { readOnly: true });

const users = sqlite.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map((row) => ({
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

const sessions = Object.fromEntries(sqlite.prepare('SELECT * FROM sessions').all().map((row) => [
  row.token,
  { userId: row.user_id, createdAt: row.created_at }
]));

const decks = sqlite.prepare('SELECT * FROM decks ORDER BY datetime(created_at) DESC').all().map((row) => ({
  id: row.id,
  userId: row.user_id,
  prompt: row.prompt,
  templateId: row.template_id,
  templateSlug: row.template_slug,
  title: row.title,
  deckPath: row.deck_path,
  r2Key: row.file_path ? `decks/${row.user_id}/${row.id}.html` : '',
  originalR2Key: row.original_html_path ? `decks/${row.user_id}/${row.id}.original.html` : '',
  status: row.status,
  currentPage: Number(row.current_page || 1),
  targetContext: row.target_context || '',
  error: row.error || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at || '',
  completedAt: row.completed_at || '',
  lastAppliedAt: row.last_applied_at || '',
  messages: [],
  comments: [],
  versions: []
}));

const byDeckId = new Map(decks.map((deck) => [deck.id, deck]));

for (const row of sqlite.prepare('SELECT * FROM deck_messages ORDER BY datetime(created_at) ASC').all()) {
  const deck = byDeckId.get(row.deck_id);
  if (!deck) continue;
  deck.messages.push({
    id: row.id,
    role: row.role,
    text: row.text,
    page: row.page,
    createdAt: row.created_at
  });
}

for (const row of sqlite.prepare('SELECT * FROM deck_comments ORDER BY datetime(created_at) ASC').all()) {
  const deck = byDeckId.get(row.deck_id);
  if (!deck) continue;
  deck.comments.push({
    id: row.id,
    page: Number(row.page || 1),
    note: row.note,
    x: Number(row.x || 0),
    y: Number(row.y || 0),
    selector: row.selector || '',
    elementText: row.element_text || '',
    elementTag: row.element_tag || '',
    elementRect: parseJson(row.element_rect_json),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || ''
  });
}

for (const row of sqlite.prepare('SELECT * FROM deck_versions ORDER BY datetime(created_at) ASC').all()) {
  const deck = byDeckId.get(row.deck_id);
  if (!deck) continue;
  deck.versions.push({
    id: row.id,
    label: row.label || '',
    r2Key: row.file_path ? `versions/${deck.userId}/${deck.id}/${row.id}.html` : '',
    createdAt: row.created_at
  });
}

const logs = sqlite.prepare('SELECT * FROM logs ORDER BY datetime(created_at) DESC LIMIT 500').all().map((row) => ({
  id: row.id,
  level: row.level,
  message: row.message,
  meta: parseJson(row.meta_json),
  createdAt: row.created_at
}));

const usageEvents = sqlite.prepare('SELECT * FROM usage_events ORDER BY datetime(created_at) DESC').all().map((row) => ({
  id: row.id,
  userId: row.user_id || '',
  identityType: row.identity_type,
  identityKey: row.identity_key,
  action: row.action,
  costCents: Number(row.cost_cents || 0),
  createdAt: row.created_at
}));

const verificationTokens = sqlite.prepare('SELECT * FROM email_verification_tokens ORDER BY datetime(created_at) DESC').all().map((row) => ({
  token: row.token,
  userId: row.user_id,
  pendingGuestUserId: row.pending_guest_user_id || '',
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at || ''
}));

const signupVerificationTokens = sqlite.prepare('SELECT * FROM signup_verification_tokens ORDER BY datetime(created_at) DESC').all().map((row) => ({
  token: row.token,
  email: row.email,
  name: row.name || '',
  pendingGuestUserId: row.pending_guest_user_id || '',
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at || ''
}));

const state = { users, sessions, decks, logs, usageEvents, verificationTokens, signupVerificationTokens };
const stateJson = JSON.stringify(state);
fs.writeFileSync(STATE_SQL, `CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);\nINSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('db', ${sqlString(stateJson)}, datetime('now'));\n`);

const uploadEntries = [];
for (const row of sqlite.prepare('SELECT id, user_id, file_path, original_html_path FROM decks').all()) {
  if (row.file_path && fs.existsSync(row.file_path)) uploadEntries.push({ source: row.file_path, key: `decks/${row.user_id}/${row.id}.html` });
  if (row.original_html_path && fs.existsSync(row.original_html_path)) uploadEntries.push({ source: row.original_html_path, key: `decks/${row.user_id}/${row.id}.original.html` });
}
for (const row of sqlite.prepare('SELECT deck_versions.id, deck_versions.file_path, decks.id AS deck_id, decks.user_id FROM deck_versions JOIN decks ON decks.id = deck_versions.deck_id').all()) {
  if (row.file_path && fs.existsSync(row.file_path)) uploadEntries.push({ source: row.file_path, key: `versions/${row.user_id}/${row.deck_id}/${row.id}.html` });
}

fs.writeFileSync(R2_MANIFEST, `${JSON.stringify(uploadEntries, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, STATE_SQL)}`);
console.log(`Wrote ${path.relative(ROOT, R2_MANIFEST)} with ${uploadEntries.length} R2 object(s)`);
console.log('Note: existing Node scrypt password hashes cannot be verified by the Worker. Create new Cloudflare users or reset passwords after migration.');

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
