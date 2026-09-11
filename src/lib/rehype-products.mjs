/**
 * Wraps product and technology names in <span class="product"> so they can be
 * styled consistently across the book, without the author tagging each mention.
 *
 * Scope: names the reader might act on - databases, hosting, drivers, ORMs,
 * tools, extensions. Not operating systems or browsers, which appear in this
 * book only as evidence of ubiquity; highlighting those turns the "where it
 * runs" paragraph into a list of decorations. Not SQLite either, for obvious
 * reasons.
 *
 * Only the first mention per chapter is marked. Repeat mentions read as normal
 * prose, which keeps a page that says "Turso" twelve times from speckling. Set
 * ONCE_PER_CHAPTER to false to mark every occurrence instead.
 */

const ONCE_PER_CHAPTER = true;

export const PRODUCTS = [
  // Client/server databases
  "PostgreSQL", "Postgres", "MySQL", "MariaDB", "SQL Server", "Oracle",
  // SQLite forks, services and hosts
  "Turso Database", "Turso Cloud", "Turso", "libSQL", "Cloudflare D1", "Cloudflare",
  "Litestream", "AWS Lambda", "Lambda", "Vercel", "Railway", "Docker", "Fly.io",
  // Drivers, ORMs and query builders
  "better-sqlite3", "node:sqlite", "Bun", "Microsoft.Data.Sqlite", "SQLitePCLRaw",
  "System.Data.SQLite", "Dapper", "EF Core", "Entity Framework", "Drizzle", "Prisma",
  // Tools
  "sqlite-utils", "DB Browser for SQLite", "DB Browser", "DBeaver", "sqlite3_rsync",
  // Extensions and encryption
  "SQLCipher", "sqlean", "sqlite-vec", "R*Tree", "geopoly", "ICU", "SEE",
];

const SKIP_TAGS = new Set([
  "pre", "code", "a", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "kbd", "samp",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern() {
  // Longest first, so "Cloudflare D1" wins over "Cloudflare" and "Turso Cloud" over "Turso".
  const alternatives = [...PRODUCTS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");

  // Lookarounds rather than \b, because names like ".NET" and "node:sqlite" do
  // not start or end on a word boundary.
  return new RegExp("(?<![\\w-])(" + alternatives + ")(?![\\w-])", "g");
}

const PATTERN = buildPattern();

export default function rehypeProducts() {
  return (tree) => {
    const seen = new Set();

    const markText = (node) => {
      PATTERN.lastIndex = 0;
      const parts = [];
      let cursor = 0;
      let match;

      while ((match = PATTERN.exec(node.value)) !== null) {
        const name = match[1];
        if (ONCE_PER_CHAPTER && seen.has(name)) continue;
        seen.add(name);

        if (match.index > cursor) {
          parts.push({ type: "text", value: node.value.slice(cursor, match.index) });
        }
        parts.push({
          type: "element",
          tagName: "span",
          properties: { className: ["product"] },
          children: [{ type: "text", value: name }],
        });
        cursor = match.index + name.length;
      }

      if (parts.length === 0) return null;
      if (cursor < node.value.length) {
        parts.push({ type: "text", value: node.value.slice(cursor) });
      }
      return parts;
    };

    const walk = (node) => {
      if (!node.children) return;

      const children = [];
      let changed = false;

      for (const child of node.children) {
        if (child.type === "element") {
          if (!SKIP_TAGS.has(child.tagName)) walk(child);
          children.push(child);
          continue;
        }

        if (child.type !== "text") {
          children.push(child);
          continue;
        }

        const parts = markText(child);
        if (parts) {
          children.push(...parts);
          changed = true;
        } else {
          children.push(child);
        }
      }

      if (changed) node.children = children;
    };

    walk(tree);
  };
}
