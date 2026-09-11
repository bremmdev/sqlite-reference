import { getCollection, type CollectionEntry } from "astro:content";

/**
 * The only module that knows about the numeric filename prefixes. Everything
 * else asks for chapters in reading order and gets numbers already computed.
 */

const PART_TITLES: Record<string, string> = {
  foundations: "Part I · Foundations",
  "data-modeling": "Part II · Data Modeling",
  querying: "Part III · Querying",
  performance: "Part IV · Performance",
  "internals-and-operations": "Part V · Internals and Operations",
  "in-your-application": "Part VI · SQLite in Your Application",
  "beyond-the-core": "Part VII · Beyond the Core",
  appendices: "Appendices",
};

export type BookChapter = {
  entry: CollectionEntry<"chapters">;
  /** Global position in the book, 1-based. Computed, never stored. */
  number: number;
  partSlug: string;
  partTitle: string;
  href: string;
};

export type BookPart = {
  slug: string;
  title: string;
  chapters: BookChapter[];
};

/** Every chapter in reading order. Drafts are visible in dev, hidden in builds. */
export async function getBookChapters(): Promise<BookChapter[]> {
  const entries = (await getCollection("chapters"))
    .filter((entry) => import.meta.env.DEV || !entry.data.draft)
    // filePath still carries the prefixes: ".../01-foundations/02-getting-started.mdx"
    .sort((a, b) => (a.filePath ?? a.id).localeCompare(b.filePath ?? b.id));

  return entries.map((entry, index) => {
    const partSlug = partSlugFromPath(entry.filePath ?? "");
    return {
      entry,
      number: index + 1,
      partSlug,
      partTitle: PART_TITLES[partSlug] ?? partSlug,
      href: `/book/${entry.id}`,
    };
  });
}

/** The same chapters grouped into parts, for the table of contents and sidebar. */
export async function getBookParts(): Promise<BookPart[]> {
  const parts: BookPart[] = [];
  for (const chapter of await getBookChapters()) {
    const last = parts.at(-1);
    if (last?.slug === chapter.partSlug) last.chapters.push(chapter);
    else parts.push({ slug: chapter.partSlug, title: chapter.partTitle, chapters: [chapter] });
  }
  return parts;
}

/** Current chapter plus its neighbours, so a reader can page through the book. */
export async function getChapterNav(id: string) {
  const chapters = await getBookChapters();
  const index = chapters.findIndex((chapter) => chapter.entry.id === id);
  if (index === -1) throw new Error(`Unknown chapter id: ${id}`);
  return {
    current: chapters[index]!,
    prev: chapters[index - 1] ?? null,
    next: chapters[index + 1] ?? null,
  };
}

/**
 * Resolve a chapter by id — for cross-references that must not hardcode a number.
 * Returns undefined for a chapter that is not written yet, so prose can point
 * forward at planned chapters without breaking the build.
 */
export async function getChapterRef(id: string): Promise<BookChapter | undefined> {
  return (await getBookChapters()).find((candidate) => candidate.entry.id === id);
}

function partSlugFromPath(filePath: string): string {
  const segments = filePath.split("/");
  const fileIndex = segments.length - 1;
  // A chapter is either <part>/<file> or <part>/<chapter>/index.<ext>
  const partIndex = segments[fileIndex]?.startsWith("index.") ? fileIndex - 2 : fileIndex - 1;
  return (segments[partIndex] ?? "").replace(/^\d+-/, "");
}
