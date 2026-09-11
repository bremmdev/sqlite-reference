// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';

import rehypeProducts from './src/lib/rehype-products.mjs';

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()]
  },

  // Astro 7 defaults to Satteri, a Rust Markdown processor with no
  // unified-compatible plugin surface. Selecting the `unified` processor
  // explicitly is the supported way to run rehype plugins; the deprecated route
  // is the top-level `markdown.rehypePlugins` key. MDX inherits this processor
  // via extendMarkdownConfig, which defaults to true.
  markdown: {
    processor: unified({ rehypePlugins: [rehypeProducts] })
  },

  integrations: [mdx()]
});