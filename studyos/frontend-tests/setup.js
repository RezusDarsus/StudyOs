// Test bootstrap: the frontend modules are plain scripts that attach to window.*. Loading them in
// Node with window aliased to globalThis makes their pure logic testable without a DOM or a
// bundler. app.js is intentionally NOT loadable here — it is bootstrap glue and needs a DOM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

export function load(scriptPath) {
  const code = readFileSync(path.join(root, scriptPath), 'utf8');
  (0, eval)(code);
}

export function loadAll(...paths) { paths.forEach(load); }
