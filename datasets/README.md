# Datasets

The databases the book runs on. Every query printed in a chapter was run against
the copy checked in here, so a reader who downloads the file gets the same rows.

## journal

`journal/journal.db` — a personal journal. 219 entries over two years, each with
at most one mood and any number of tags, plus quotes and the session storage a
small web application needs for its one user.

| Table       | Rows | What it is there for                                              |
| ----------- | ---: | ----------------------------------------------------------------- |
| `entry`     |  219 | The journal itself. One row per day written; four lack a mood.    |
| `entry_tag` |  397 | M:N junction, `WITHOUT ROWID`, composite primary key.             |
| `tag`       |   11 | Deliberately skewed: 77 entries down to 14, and one unused.       |
| `mood`      |    8 | Lookup table, three sentiment buckets.                            |
| `quote`     |   18 | Nullable author, case variants, a `NOCASE` index that mismatches. |
| `user`      |    1 | The journal's owner. Fake credentials.                            |
| `session`   |   12 | `WITHOUT ROWID`, TEXT primary key. See the note below.            |
| `entry_fts` |    — | FTS5 external-content index kept in sync by triggers.             |

The gaps are deliberate. Four entries have no mood, one has no tags, and the
`travel` tag is on no entry, so an inner join and an outer join return
different rows, and `count(*)` and `count(mood_id)` disagree.

Sessions are written against the generator's frozen clock of
`2026-01-15 09:00:00` UTC. Four had expired at that instant; against today's
real clock all twelve have, so compare `expires_at` with that fixed timestamp
rather than `datetime('now')` to reproduce the book's numbers. Every timestamp
is in SQLite's own `YYYY-MM-DD HH:MM:SS` format, the one `datetime()` returns,
so the two do compare correctly as text.

**Turn on foreign keys.** Enforcement is a per-connection setting and is not
stored in the file. The `sqlite3` shell starts every session with it off, and in
that state the `ON DELETE` rules in the schema silently do nothing. Run
`PRAGMA foreign_keys = ON;` after opening the database, or put it in
`~/.sqliterc`. (`node:sqlite` turns it on by default.)

### Rebuilding it

```bash
cd journal
node seed.mjs        # requires Node 22.13+ for node:sqlite
```

The generator is deterministic: a fixed seed, a fixed date range, and no value
taken from the clock. It produces the same rows on every machine and every run,
which is what lets the book print a result and have it stay true. Change `SEED`
in `seed.mjs` and every entry changes with it, so don't, unless you intend to
re-check every query in the book.

`schema.sql` builds an empty copy on its own:

```bash
sqlite3 fresh.db < journal/schema.sql
```

### Provenance

All content is generated. The entries, titles, username and password hash are
invented by `seed.mjs` from the word pools it contains; nothing here is anyone's
real journal, and no credential is real. The quotes are real, and each one with
an author is credited to its actual source rather than to a popular
misattribution.
