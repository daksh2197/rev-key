/**
 * Runs after `vite build`. It writes two things into dist/sw.js:
 *
 *   1. the list of files the service worker should save for offline use
 *   2. a version made from the contents of those files
 *
 * Because the version comes from the contents, it changes when the app changes
 * and stays the same when it doesn't. Nobody has to remember to bump a number.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// Not needed offline: the worker itself, and the preview image that only link unfurlers fetch.
const SKIP = new Set(['sw.js', 'og.png']);

function filesIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

const files = filesIn(dist)
  .map((path) => relative(dist, path).split(sep).join('/'))
  .filter((path) => !SKIP.has(path))
  .sort();

const hash = createHash('sha256');
for (const file of files) hash.update(file).update(readFileSync(join(dist, file)));
const version = hash.digest('hex').slice(0, 10);

// "./" is the page itself, so index.html does not need its own entry.
const list = ['./', ...files.filter((file) => file !== 'index.html').map((file) => `./${file}`)];

const workerPath = join(dist, 'sw.js');
const worker = readFileSync(workerPath, 'utf8')
  .replace("'__VERSION__'", JSON.stringify(version))
  .replace("['__FILES__']", JSON.stringify(list, null, 2));

if (worker.includes('__VERSION__') || worker.includes('__FILES__')) {
  throw new Error('stamp-sw: the placeholders in public/sw.js were not found. Did someone rename them?');
}

writeFileSync(workerPath, worker);
console.log(`stamp-sw: version ${version}, ${list.length} files saved for offline use`);
