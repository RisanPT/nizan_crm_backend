#!/usr/bin/env node
// PRE-DEPLOY CHECK — "will this backend start?", without starting it.
//
//   npm run check            (from the backend folder; exit 1 = do NOT deploy)
//
// 1. Every .js / .mjs file passes `node --check` (catches a duplicate `const`, a stray brace, a bad merge…).
// 2. Every module in models/ routes/ controllers/ services/ utils/ middleware/ config/ IMPORTS (catches a missing file, a named export
//    that no longer exists, a model defined twice…) — the same linking the server does at start. No database is connected and
//    server.js is never started; every secret-looking env var is blanked first so nothing can reach the outside world.
// 3. server.js does not mount the same API path twice (the second mount would quietly never be reached).
//
// It exits itself at the end: some modules start timers when imported.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const DIRS = ['models', 'routes', 'controllers', 'services', 'utils', 'middleware', 'config'];
const problems = [];

// nothing may reach a real service or database while modules load
for (const k of Object.keys(process.env)) {
  if (/KEY|SECRET|TOKEN|PASS|MONGO|SMTP|NODEMAILER|MSG91|CLOUDINARY|DROPBOX|META_|TIMEBOX|GEMINI|ORS_|WHATSAPP|TWILIO|URI|URL/i.test(k)) {
    process.env[k] = '';
  }
}
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const jsFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?js)$/.test(n)) out.push(full);
    }
  };
  walk(dir);
  return out;
};

// ── 1. syntax ──────────────────────────────────────────────────────────────
const toCheck = [path.join(root, 'server.js'), ...DIRS.flatMap((d) => jsFiles(path.join(root, d))), ...jsFiles(path.join(root, 'scripts'))];
for (const f of toCheck) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr ?? e.message).split('\n').find((l) => /Error/.test(l)) ?? 'syntax error';
    problems.push(`SYNTAX   ${path.relative(root, f)}: ${msg.trim()}`);
  }
}

// ── 3. the same API path mounted twice ─────────────────────────────────────
try {
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  const mounts = [...server.matchAll(/app\.use\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const twice = [...new Set(mounts.filter((m, i) => mounts.indexOf(m) !== i))];
  for (const m of twice) problems.push(`MOUNT    server.js mounts ${m} more than once (the second is never reached)`);
} catch (e) {
  problems.push(`MOUNT    could not read server.js: ${e.message}`);
}

// ── 2. every module links (only when the syntax is clean: a syntax error would only be reported twice) ───────────
if (!problems.some((p) => p.startsWith('SYNTAX'))) {
  for (const dir of DIRS) {
    for (const f of jsFiles(path.join(root, dir))) {
      try {
        await import(pathToFileURL(f).href);
      } catch (e) {
        problems.push(`IMPORT   ${path.relative(root, f)}: ${String(e?.message ?? e).split('\n')[0]}`);
      }
    }
  }
}

if (problems.length) {
  console.error(`\n✖ NOT READY TO DEPLOY — ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nFix these first: the server would not start (or part of it would be unreachable).\n');
  process.exit(1);
}
console.log(`✔ Ready to deploy: ${toCheck.length} files pass the syntax check, every module loads, no API path is mounted twice.`);
process.exit(0);
