-- Sterling Quest Sync server schema, version 1.
-- Secrets (keys, codes) are stored only as SHA-256 hex. Nothing here is an email, password or IP.

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,              -- 16 hex chars, random
  created_at    INTEGER NOT NULL,              -- unix seconds
  last_seen     INTEGER NOT NULL,              -- updated at most once a day
  recovery_hash TEXT UNIQUE,                   -- SHA-256 of the recovery code, or NULL
  banned        INTEGER NOT NULL DEFAULT 0,
  ever_paired   INTEGER NOT NULL DEFAULT 0,    -- unpaired accounts expire after 7 days
  invited_by    TEXT                           -- only set in invite-only mode
);
CREATE INDEX accounts_last_seen ON accounts(last_seen);
CREATE INDEX accounts_unpaired ON accounts(ever_paired, created_at);
CREATE INDEX accounts_invited_by ON accounts(invited_by);

-- One row per PC. A PC proves who it is with its key; we store only the hash.
CREATE TABLE keys (
  hash        TEXT PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,            -- public id for listing and removal
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX keys_account ON keys(account_id);

-- Characters an account has listed. Not unique per GUID on purpose: GUIDs are public, listing one grants nothing.
CREATE TABLE characters (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  guid        TEXT NOT NULL,
  name        TEXT NOT NULL,
  realm       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, guid)
);

-- A pairing links one character on one account to one character on another account.
-- No foreign keys: when an account is deleted its side is scrubbed and the pairing is ended, so the
-- other side can still see "ended" and show "missing key, resync".
CREATE TABLE pairings (
  id            TEXT PRIMARY KEY,
  a_account     TEXT NOT NULL,
  a_guid        TEXT NOT NULL,
  a_name        TEXT NOT NULL,
  a_realm       TEXT NOT NULL,
  a_key         TEXT NOT NULL,                 -- signing key half for side A
  b_account     TEXT NOT NULL,
  b_guid        TEXT NOT NULL,
  b_name        TEXT NOT NULL,
  b_realm       TEXT NOT NULL,
  b_key         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  ended_reason  TEXT                           -- removed, replaced, deleted, expired, banned
);
CREATE INDEX pairings_a ON pairings(a_account, a_guid);
CREATE INDEX pairings_b ON pairings(b_account, b_guid);
CREATE INDEX pairings_ended ON pairings(ended_at);

-- Latest full copy per uploader, from character and to character. to = from is the self slot.
CREATE TABLE slots (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_guid   TEXT NOT NULL,
  to_guid     TEXT NOT NULL,
  packet      TEXT NOT NULL,
  game_time   INTEGER NOT NULL,                -- GetServerTime() at the save
  proto       INTEGER NOT NULL,                -- Sterling sync protocol number
  seq         INTEGER NOT NULL,                -- server-assigned, always increasing
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, from_guid, to_guid)
);
CREATE INDEX slots_seq ON slots(seq);
CREATE INDEX slots_updated ON slots(updated_at);

-- Short-lived codes. All stored hashed, all single use.
CREATE TABLE pair_codes (
  hash        TEXT PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  guid        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX pair_codes_owner ON pair_codes(account_id, guid);
CREATE INDEX pair_codes_expires ON pair_codes(expires_at);

CREATE TABLE link_codes (
  hash        TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX link_codes_expires ON link_codes(expires_at);

CREATE TABLE invites (
  hash        TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX invites_expires ON invites(expires_at);

CREATE TABLE settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO settings (k, v) VALUES ('signups', 'open');

CREATE TABLE counters (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
INSERT INTO counters (k, v) VALUES ('seq', 0), ('deleted', 0);
