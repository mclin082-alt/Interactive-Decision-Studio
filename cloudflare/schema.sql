CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_state (key, value, updated_at)
VALUES ('db', '{"users":[],"sessions":{},"decks":[],"logs":[],"usageEvents":[],"verificationTokens":[],"signupVerificationTokens":[]}', datetime('now'));
