/**
 * One-time migration for company-wide (department-scoped) Projects.
 *
 * Historically every project was created through the IT screen, which either
 * hardcoded `targetDepartment: 'it'` or left the schema default (`'general'`).
 * With projects going company-wide, `targetDepartment` becomes a live Department
 * NAME used for scoping (matched case-insensitively against Department.name and
 * resolveUserDeptName). This normalises those legacy/empty values to 'IT' so the
 * existing projects show up correctly for the IT department.
 *
 * Only touches projects whose targetDepartment is empty / 'it' / 'general'
 * (case-insensitive) — never overwrites a real department name. Idempotent.
 *
 * Usage:
 *   node scripts/normalizeProjectDepartments.js            # dry run, no writes
 *   node scripts/normalizeProjectDepartments.js --apply    # write 'IT'
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Project from '../models/Project.js';

const APPLY = process.argv.includes('--apply');
const LEGACY = [null, '', 'it', 'general'];

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  const all = await Project.find({}).select('name targetDepartment').lean();
  const toFix = all.filter((p) => LEGACY.includes((p.targetDepartment || '').trim().toLowerCase()));

  console.log(`Projects total: ${all.length} · needing normalisation: ${toFix.length}`);
  toFix.slice(0, 20).forEach((p) => console.log(`  "${p.name}" · "${p.targetDepartment || ''}" → "IT"`));

  if (APPLY && toFix.length > 0) {
    const res = await Project.updateMany(
      { _id: { $in: toFix.map((p) => p._id) } },
      { $set: { targetDepartment: 'IT' } },
    );
    console.log(`\nUpdated ${res.modifiedCount} project(s) to 'IT'.`);
  } else if (!APPLY && toFix.length > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
