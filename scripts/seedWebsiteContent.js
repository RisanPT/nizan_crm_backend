/**
 * seedWebsiteContent.js
 * ──────────────────────────────────────────────────────────────────────────
 * Copies the website's built-in text into Team N Website as DRAFTS, so staff
 * start from the current wording instead of empty forms.
 *
 * Safe by design:
 *   - DRY RUN by default: prints what it would do and writes nothing.
 *   - Only creates sections that do not exist yet. Never overwrites, never
 *     deletes, never publishes. The live site keeps its built-in text until
 *     someone presses Publish in the CRM.
 *   - Text only. Photos are uploaded by staff in the CRM (they must pass the
 *     upload checks).
 *
 * Usage:
 *   node scripts/seedWebsiteContent.js                   (dry run, data/websiteSeed.json)
 *   node scripts/seedWebsiteContent.js --apply           (writes the drafts)
 *   node scripts/seedWebsiteContent.js path/to/seed.json [--apply]
 *
 * Refresh data/websiteSeed.json from the website with:
 *   cd TeamNMakeovers && npm run export:cms-seed -- ../nizan_crm_backend/data/websiteSeed.json
 */
import dotenv from 'dotenv';
import fs from 'fs';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import WebsiteSection from '../models/WebsiteSection.js';
import { planWebsiteSeed } from '../utils/websiteSeed.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--')) || path.join(root, 'data', 'websiteSeed.json');

const main = async () => {
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sections = seed.sections ?? seed;

  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  const existingKeys = (await WebsiteSection.find({}).select('key').lean()).map((s) => s.key);
  const plan = planWebsiteSeed(sections, existingKeys);

  console.log(`\nSeed file: ${file}`);
  console.log(`Would create ${plan.create.length} draft section(s):`);
  for (const c of plan.create) console.log(`  + ${c.key}`);
  for (const s of plan.skip) console.log(`  = ${s.key}: ${s.reason}`);
  for (const i of plan.invalid) console.log(`  ! ${i.key}: ${i.errors.join('; ')}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to create these drafts.');
    return;
  }

  const now = new Date();
  for (const c of plan.create) {
    // Re-check right before writing so a section set up meanwhile is never touched.
    if (await WebsiteSection.exists({ key: c.key })) {
      console.log(`  = ${c.key}: created meanwhile — skipped`);
      continue;
    }
    await WebsiteSection.create({ key: c.key, draft: c.draft, status: 'draft', draftUpdatedAt: now });
    console.log(`  ✓ ${c.key} saved as draft`);
  }
  console.log('\nDone. Nothing is live yet: review each section in Team N Website, add photos, then Publish.');
};

main()
  .catch((e) => {
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
