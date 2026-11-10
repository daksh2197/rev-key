import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// package.json is the one place the project's addresses are written down.
// The deploy workflow can override them (see .github/workflows/ship.yml).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version?: string;
  homepage?: string;
  repository?: { url?: string };
};
const siteUrl = (process.env.SITE_URL || pkg.homepage || '.').replace(/\/$/, '');
const repoUrl = process.env.REPO_URL || pkg.repository?.url || 'https://github.com';

export default defineConfig({
  // Relative paths, so the same build works at <user>.github.io/rev-key/,
  // on a custom domain, or from any subfolder.
  base: './',
  build: {
    target: 'es2022',
  },
  plugins: [
    {
      name: 'fill-in-links',
      transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl).replaceAll('%REPO_URL%', repoUrl),
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
