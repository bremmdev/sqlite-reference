import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from 'astro/zod'

/**
 * Chapters live in part folders, both numerically prefixed:
 *
 *   src/content/chapters/01-foundations/03-sql-crash-course.mdx
 *
 * The prefixes are the single source of truth for reading order. They are
 * stripped from the id, so the URL is /book/sql-crash-course and renumbering
 * or moving a chapter between parts never breaks a link.
 *
 * A chapter may be a single file or a folder with an index file beside its
 * figures (03-sql-crash-course/index.mdx); both produce the same id.
 */
const chapters = defineCollection({
  loader: glob({
    pattern: "**/*.{md,mdx}",
    base: "./src/content/chapters",
    generateId: ({ entry }) => {
      const segments = entry.replace(/\.mdx?$/, "").split("/");
      const last = segments.at(-1) === "index" ? segments.at(-2)! : segments.at(-1)!;
      return last.replace(/^[\da-z]+-/, "");
    },
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    draft: z.boolean().default(false),
    /** Sketch numbers in _sketches/ this chapter draws on, for the provenance audit. */
    sketches: z.array(z.string()).default([]),
  }),
});

export const collections = { chapters };
