-- ============================================================================
-- journal.db — the book's first running dataset
--
-- A personal journal: one entry per day you wrote, each given at most one mood
-- and any number of tags, plus a quotes table and the session storage a
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

-- Foreign key enforcement is a property of the connection, not of the file.
-- This line turns it on for whatever connection runs this script and nothing
-- else: it is not stored in journal.db, and the sqlite3 shell starts every
-- session with it off. Run `PRAGMA foreign_keys = ON;` yourself after opening
-- the database, or the ON DELETE actions below silently do nothing. It has to
-- come before BEGIN, because inside a transaction the pragma is a no-op.
PRAGMA foreign_keys = ON;

BEGIN;

PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- A controlled vocabulary of moods. `sentiment` groups the eight moods into
-- three buckets, so a query can aggregate by sentiment without every entry
-- carrying a redundant copy of it. This is the smallest useful example of a
-- lookup table, and the join in front of nearly every query in Part III.
--
-- A CHECK constraint is the only thing standing between this column and any
-- string at all: SQLite has no ENUM type, and a TEXT column accepts whatever it
-- is given.
CREATE TABLE mood (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative'))
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
--
-- The CHECK on `date` rejects anything date() would not hand back unchanged:
-- 'last tuesday', '2024-1-5' and '2024-02-30' all fail it. Without it, a TEXT
-- column stores any of them without complaint.
--
-- `mood_id` is nullable because picking a mood is optional, and a handful of
-- entries have none.
CREATE TABLE entry (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  date    TEXT NOT NULL CHECK (date IS date(date)), -- 'YYYY-MM-DD'; sorts chronologically
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

-- UPDATE OF limits this to the columns the index cares about, so changing an
-- entry's mood does not rewrite its search terms. `id` is on the list because
-- the index is keyed by it: were an id ever changed, the terms must move too.
CREATE TRIGGER entry_au AFTER UPDATE OF id, title, content ON entry BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, title, content)
  VALUES ('delete', OLD.id, OLD.title, OLD.content);
  INSERT INTO entry_fts(rowid, title, content) VALUES (NEW.id, NEW.title, NEW.content);
END;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

-- `author` is nullable on purpose: some quotes are anonymous, which makes this
-- the table to reach for when NULL comparison, IS NOT NULL and NULLS LAST need
-- a worked example. Kierkegaard is here for his ø: NOCASE, upper() and lower()
-- only fold ASCII letters, so 'SØREN' and 'Søren' stay different.
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

-- One row: the journal's owner. The entries need no user_id, because there is
-- only one person they could belong to; the table exists because a web
-- application still needs somewhere to keep a password hash.
--
-- The NOCASE collation sits on the column, so the unique index inherits it and
-- serves `WHERE username = ?` — the opposite of the quote index above, where
-- the collation is on the index alone. It also stops 'Matt' being registered
-- next to 'matt'.
CREATE TABLE user (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL COLLATE NOCASE,
  passwordhash TEXT NOT NULL,          -- scrypt, 64-byte, hex
  salt         TEXT NOT NULL           -- 16-byte, hex
);

CREATE UNIQUE INDEX idx_user_username ON user(username);

-- WITHOUT ROWID, so the table *is* the session_id B-tree: the lookup that runs
-- on every page navigation is one descent, and no secondary index on
-- session_id is needed or wanted. The whole row lives in that B-tree, so it
-- should stay small — SQLite suggests under about a twentieth of a page — or it
-- spills onto overflow pages and the single descent stops being one read.
--
-- Timestamps use SQLite's own 'YYYY-MM-DD HH:MM:SS' in UTC, which is what
-- CURRENT_TIMESTAMP and datetime('now') produce. Text comparison is only
-- correct when both sides share one format, and the CHECKs keep it that way.
CREATE TABLE session (
  session_id TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             CHECK (created_at IS datetime(created_at)),
  expires_at TEXT NOT NULL
             CHECK (expires_at IS datetime(expires_at)),
  -- A session outlives nothing: deleting the user logs them out everywhere.
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID;

-- No index on user_id, despite the rule on entry(mood_id) above. With one user
-- every row holds the same value, so an index could never narrow a search.
--
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
  (5, 'calm',       'neutral'),
  (6, 'proud',      'positive'),
  (7, 'sad',        'negative'),
  (8, 'determined', 'positive');

COMMIT;
