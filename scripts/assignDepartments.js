/**
 * One-off: organise existing staff into departments so the department-head
 * model works. Every employee currently sits in the default 'Staff' department
 * (the old create/update hardcoded it), which means a CRM/Sales/Marketing head
 * scoped to 'Artist'/'Sales'/'Marketing' would see nobody.
 *
 * Mapping (only applied to employees still in 'Staff'):
 *   artistRole 'driver'                        -> Fleet
 *   category   'sales'                          -> Sales
 *   category   'marketing'                      -> Marketing
 *   category   'admin' | 'administrative'       -> Admin
 *   otherwise (artists / assistants / creative) -> Artist
 *
 * Usage:
 *   node scripts/assignDepartments.js          # dry run, changes nothing
 *   node scripts/assignDepartments.js --apply  # write the departments
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Employee from '../models/Employee.js';

const APPLY = process.argv.includes('--apply');

const departmentFor = (e) => {
  if (e.artistRole === 'driver') return 'Fleet';
  const cat = String(e.category ?? '').toLowerCase();
  if (cat === 'sales') return 'Sales';
  if (cat === 'marketing') return 'Marketing';
  if (cat === 'admin' || cat === 'administrative') return 'Admin';
  return 'Artist';
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  // Only touch employees still in the generic 'Staff' bucket, so a department
  // an admin already set is never overwritten.
  const employees = await Employee.find({
    $or: [{ department: 'Staff' }, { department: { $in: [null, ''] } }],
  });

  const counts = {};
  const samples = [];
  for (const e of employees) {
    const dept = departmentFor(e);
    counts[dept] = (counts[dept] ?? 0) + 1;
    if (samples.length < 20) {
      samples.push(`  ${e.name} (${e.artistRole}/${e.category || '—'}) -> ${dept}`);
    }
    if (APPLY) {
      e.department = dept;
      await e.save();
    }
  }

  console.log(`Employees in 'Staff' to reassign: ${employees.length}`);
  console.log('By department:', JSON.stringify(counts));
  if (samples.length > 0) {
    console.log('\nSamples:');
    console.log(samples.join('\n'));
  }
  if (!APPLY && employees.length > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
