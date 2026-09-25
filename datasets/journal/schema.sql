-- ============================================================================
-- journal.db — the book's first running dataset
--
-- A personal journal: one entry per day you wrote, each classified by a single
-- mood and any number of tags, plus a quotes table and the session storage a
-- small web application needs.
--
-- Build an empty database from this file:
--     sqlite3 journal.db < schema.sql
--
-- To build it *with* data, run the generator instead, which applies this file
-- and then fills it:
--     node seed.mjs
--
-- The comments here explain why each choice was made. Every one of them is
-- picked up and argued properly in a later chapter.
-- ============================================================================

PRAGMA foreign_keys = OFF;   -- deferred until every table exists
BEGIN;

PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- A controlled vocabulary of moods. `sentiment` groups the eight moods into
-- three buckets, so a query can aggregate by sentiment without every entry
-- carrying a redundant copy of it. This is the smallest useful example of a
-- lookup table, and the join in front of nearly every query in Part III.
CREATE TABLE mood (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  sentiment TEXT NOT NULL              -- 'positive' | 'neutral' | 'negative'
);

CREATE TABLE tag (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

-- UNIQUE lives in the index rather than the column. SQLite implements a UNIQUE
-- column constraint as exactly this, and writing it out makes the index visible
-- to the reader. BINARY collation is deliberate: a NOCASE index here would stop
-- serving `WHERE name = ?`, which is the failure the quote table below exists
-- to demonstrate.
CREATE UNIQUE INDEX idx_tag_name  ON tag(name);
CREATE UNIQUE INDEX idx_mood_name ON mood(name);

-- ---------------------------------------------------------------------------
-- Journal
-- ---------------------------------------------------------------------------

-- AUTOINCREMENT is on this table and on no other. It costs a row in the
-- `sqlite_sequence` table and an extra read and write per insert, and what it
-- buys is a guarantee that a deleted entry's id is never handed out again.
-- That is worth paying for an entry and not for a mood, so the database holds
-- both variants side by side to compare.
CREATE TABLE entry (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  date    TEXT NOT NULL,               -- 'YYYY-MM-DD'; ISO-8601 sorts chronologically
  title   TEXT NOT NULL,
  content TEXT NOT NULL,
  mood_id INTEGER,
  -- SET NULL, not CASCADE: retiring a mood must never destroy journal entries.
  FOREIGN KEY (mood_id) REFERENCES mood(id) ON UPDATE CASCADE ON DELETE SET NULL
);

-- One entry per day, enforced. It is also the index behind every date range
-- query and behind ORDER BY date, which is how the application lists entries.
CREATE UNIQUE INDEX idx_entry_date ON entry(date);

-- Foreign keys are not indexed automatically. Without this, deleting a mood has
-- to scan every entry to apply SET NULL, and "entries with this mood" is a full
-- table scan.
CREATE INDEX idx_entry_mood_id ON entry(mood_id);

-- A pure junction table: no payload beyond its two key columns, so a rowid
-- would be pure overhead and the primary key doubles as the entry -> tags
-- index. The composite key also makes a duplicate (entry_id, tag_id) pair
-- impossible.
CREATE TABLE entry_tag (
  entry_id INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (entry_id, tag_id),
  -- CASCADE both ways: a link row with a missing end is meaningless.
  FOREIGN KEY (entry_id) REFERENCES entry(id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (tag_id)   REFERENCES tag(id)   ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID;

-- The reverse direction (tag -> entries). The primary key already covers the
-- forward one, which is why there is one index here and not two.
CREATE INDEX idx_entrytag_tag_id ON entry_tag(tag_id);

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------

-- External content: the index stores terms only and reads through to `entry`
-- for the text itself, so there is no second copy of every entry to drift out
-- of date. The cost is that SQLite will not maintain it for you — the three
-- triggers below do.
CREATE VIRTUAL TABLE entry_fts USING fts5(
  title,
  content,
  content='entry',
  content_rowid='id'
);

CREATE TRIGGER entry_ai AFTER INSERT ON entry BEGIN
  INSERT INTO entry_fts(rowid, title, content) VALUES (NEW.id, NEW.title, NEW.content);
END;

-- The 'delete' command must be given the OLD column values and not just the
-- rowid: FTS5 needs them to know which term entries to retract. Getting this
-- wrong corrupts the index in a way that surfaces much later, as quietly wrong
-- search results.
CREATE TRIGGER entry_ad AFTER DELETE ON entry BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, title, content)
  VALUES ('delete', OLD.id, OLD.title, OLD.content);
END;

CREATE TRIGGER entry_au AFTER UPDATE ON entry BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, title, content)
  VALUES ('delete', OLD.id, OLD.title, OLD.content);
  INSERT INTO entry_fts(rowid, title, content) VALUES (NEW.id, NEW.title, NEW.content);
END;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

-- `author` is nullable on purpose: some quotes are anonymous, which makes this
-- the table to reach for when NULL comparison, IS NOT NULL and NULLS LAST need
-- a worked example.
CREATE TABLE quote (
  id      INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  author  TEXT
);

-- A deliberately mismatched index. It sorts case-insensitively, so it serves
-- `ORDER BY author COLLATE NOCASE` and is silently ignored by a plain
-- `WHERE author = ?`. The author names in the seed data include case variants
-- so the two collations return visibly different results.
CREATE INDEX idx_quote_author_nocase ON quote(author COLLATE NOCASE);

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------

CREATE TABLE user (
  id           INTEGER PRIMARY KEY,
  username     TEXT UNIQUE,
  passwordhash TEXT,                   -- scrypt, 64-byte, hex
  salt         TEXT,
  role         TEXT                    -- 'user' | 'admin'
);

-- WITHOUT ROWID, so the table *is* the session_id B-tree: the lookup that runs
-- on every page navigation is one descent, and no secondary index on
-- session_id is needed or wanted. Such tables use index payload limits, so the
-- whole row must stay under maxLocal (about 1002 bytes on a 4 KiB page) — one
-- reason a session id is 64 characters and not more.
CREATE TABLE session (
  session_id TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,            -- full ISO-8601 timestamp
  FOREIGN KEY (user_id) REFERENCES user(id)
) WITHOUT ROWID;

-- There is deliberately no index on expires_at. The prune runs on every login
-- and is what keeps this table at a handful of rows, so a scan beats an index
-- at every size it reaches.

-- ---------------------------------------------------------------------------
-- Seed: the mood vocabulary, which is schema rather than data
-- ---------------------------------------------------------------------------

INSERT INTO mood (id, name, sentiment) VALUES
  (1, 'frustrated', 'negative'),
  (2, 'anxious',    'negative'),
  (3, 'grateful',   'positive'),
  (4, 'happy',      'positive'),
  (5, 'neutral',    'neutral'),
  (6, 'proud',      'positive'),
  (7, 'sad',        'negative'),
  (8, 'determined', 'positive');

COMMIT;
PRAGMA foreign_keys = ON;
