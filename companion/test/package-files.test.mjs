// Every ./*.mjs bin.mjs dynamically imports must ship in the npm package, or
// `npx -y @glbforge/companion <subcommand>` throws ERR_MODULE_NOT_FOUND for
// anyone who isn't running from this monorepo checkout. hook.mjs and
// hooks.mjs landed with the Claude Code hooks feature but were never added
// to package.json's "files", so `hooks install` broke for every install
// path except this checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('package.json "files" ships every local module bin.mjs dynamically imports', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = new Set(pkg.files.map((f) => f.replace(/\/$/, '')));
  const bin = fs.readFileSync(path.join(root, 'bin.mjs'), 'utf8');
  const imported = [...bin.matchAll(/await import\('\.\/([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(imported.length > 0, 'expected bin.mjs to dynamically import at least one local module');
  for (const rel of imported) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel}: bin.mjs imports it but it does not exist on disk`);
    assert.ok(files.has(rel), `${rel}: bin.mjs imports it but package.json "files" does not list it, so npm installs would 404 on it`);
  }
});
