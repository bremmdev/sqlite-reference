# Datasets

The databases the book runs on. Every query printed in a chapter was run against
the copy checked in here, so a reader who downloads the file gets the same rows.

## journal

`journal/journal.db` — a personal journal. 219 entries over two years, each with
one mood and any number of tags, plus quotes and the session storage a small web
application needs.

| Table       | Rows | What it is there for                                  |
| ----------- | ---: | ----------------------------------------------------- |
| `entry`     |  219 | The journal itself. One row per day written.          |
| `entry_tag` |  400 | M:N junction, `WITHOUT ROWID`, composite primary key. |
| `tag`       |   10 | Deliberately skewed: 78 entries down to 14.           |
| `mood`      |    8 | Lookup table, three sentiment buckets.                |
| `quote`     |   16 | Nullable author, and a `NOCASE` index that mismatches. |
| `user`      |    3 | Fake credentials. The hashes authenticate nothing.    |
| `session`   |   12 | `WITHOUT ROWID`, TEXT primary key. See the note below. |
| `entry_fts` |    — | FTS5 external-content index kept in sync by triggers. |

Sessions are written against the generator's frozen clock of
`2026-01-15T09:00:00Z`. Exactly one had expired at that instant; against today's
real clock all twelve have, so compare `expires_at` with that fixed timestamp
rather than `datetime('now')` to reproduce the book's numbers.

About 200 KB. It is small on purpose: it is the dataset for learning the schema
and the query language, where the answer being *correct* is the whole point. It
is far too small to say anything about performance — every plan on a database
this size is fast, including the bad ones. Part IV uses a second, much larger
dataset for that.

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

All content is generated. The entries, titles, quotes, usernames and password
hashes are invented by `seed.mjs` from the word pools it contains. Nothing here
is anyone's real journal, and no credential is real.
