// Replays every ```console and ```sql block of a chapter against the journal
// dataset, in document order, and diffs the shell's real output against the
// output printed in the chapter.
//
//   node scripts/check-chapter.mjs <chapter.mdx> [journal.db]
//
// The database defaults to datasets/journal/journal.db. It is never touched:
// every run works on copies in a temporary directory, and sqlite3 runs inside
// that directory so commands like `.once file.sql` write there too.
//
// Reading blocks run against a read-only copy. A block containing `.backup`
// switches to a writable copy for everything after it, mirroring the way a
// chapter tells the reader to make a scratch copy before writing. Each block is
// one sqlite3 invocation, so error line numbers count from the start of the
// block. The shell is started as a reader's .sqliterc would leave it: box mode,
// headers on, `.nullvalue NULL`, foreign keys on.
//
// Written for chapter 3 (sql-crash-course), which passes in full. Known limits,
// found by running it on chapter 2:
//   - `$` lines are skipped, but their output is still expected from sqlite3,
//     so shell commands with output (`sqlite3 --version`, banners) fail.
//   - Only journal.db is available. Examples on another database, such as
//     chapter 2's intro.db with its `city` table, fail with "no such table".
//   - Machine-specific output (paths from `.databases`) and demos that cannot be
//     replayed (the WSL locking example) fail, and there is no marker yet to
//     exclude a block.
//   - Any output from a ```sql block counts as a failure, which is wrong for a
//     block like `select sqlite_version();`.
//   - Files a block expects to exist (`.read schema.sql`) are not provided.
import { readFileSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [chapterPath, journalPath = join(repoRoot, "datasets/journal/journal.db")] =
  process.argv.slice(2);
if (!chapterPath) {
  console.error("usage: node scripts/check-chapter.mjs <chapter.mdx> [journal.db]");
  process.exit(2);
}

const text = readFileSync(chapterPath, "utf8").replace(/\r\n/g, "\n");
const work = mkdtempSync(join(tmpdir(), "chk-"));
const readDb = join(work, "journal.db");
const writeDb = join(work, "scratch.db");
copyFileSync(journalPath, readDb);

const blocks = [...text.matchAll(/^```(console|sql)\n([\s\S]*?)^```$/gm)].map((m) => ({
  lang: m[1],
  body: m[2].replace(/\n$/, ""),
  line: text.slice(0, m.index).split("\n").length,
}));

let mode = "read";
let failures = 0;

function run(sql, db, readonly) {
  const args = [
    "-noinit", "-box",
    "-cmd", ".nullvalue NULL",
    "-cmd", "PRAGMA foreign_keys = ON",
    ...(readonly ? ["-readonly"] : []),
    db,
  ];
  const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const r = spawnSync(`sqlite3 ${quoted} 2>&1`, {
    input: sql,
    shell: "bash",
    encoding: "utf8",
    cwd: work,
  });
  return r.stdout.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

for (const block of blocks) {
  if (block.lang === "sql") {
    // Fragments (no terminating semicolon) are illustrations, not statements.
    if (!block.body.trim().endsWith(";")) continue;
    const out = run(block.body, mode === "read" ? readDb : writeDb, mode === "read");
    if (out) { failures++; console.log(`\n✗ sql block at line ${block.line} printed:\n${out}`); }
    else console.log(`✓ sql block at line ${block.line}`);
    continue;
  }

  const input = [];
  const expected = [];
  for (const line of block.body.split("\n")) {
    if (line.startsWith("sqlite> ")) input.push(line.slice(8));
    else if (line.startsWith("   ...> ")) input.push(line.slice(8));
    else if (line.startsWith("$ ")) continue;
    else expected.push(line);
  }

  if (input.some((l) => l.startsWith(".backup"))) {
    rmSync(writeDb, { force: true });
    const out = run(".backup " + writeDb.replace(/\\/g, "/"), readDb, true);
    mode = "write";
    console.log(`✓ console block at line ${block.line} (switched to writable copy)${out ? "\n" + out : ""}`);
    continue;
  }

  const db = mode === "read" ? readDb : writeDb;
  const actual = run(input.join("\n") + "\n", db, mode === "read");
  const want = expected.join("\n").replace(/\s+$/, "");
  if (actual === want) {
    console.log(`✓ console block at line ${block.line}`);
  } else {
    failures++;
    console.log(`\n✗ console block at line ${block.line}\n--- expected\n${want}\n--- actual\n${actual}\n`);
  }
}

console.log(`\n${blocks.length} blocks, ${failures} failing`);
rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
