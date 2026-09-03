/**
 * One-time migration for the department-expense approval feature.
 *
 * BEFORE this feature, every administrative expense was created with
 * status `pending` and posted to the ledger immediately — so "pending" was
 * NOT a real gate, it was just the default state of a recorded (and reported)
 * expense.
 *
 * AFTER this feature, `pending` means "a department head submitted this and it
 * is awaiting Accounts approval" — such expenses are deliberately kept OUT of
 * the ledger and the management reports until approved.
 *
 * To keep that new rule from retroactively hiding every historical expense
 * from Cash Flow / Expenses-by-Category / TDS (which now show approved-only),
 * this script marks all EXISTING pending administrative expenses as `approved`.
 * New department-head submissions made after the deploy stay pending until
 * Accounts approves them.
 *
 * Idempotent — only touches rows still `pending`, so it is safe to re-run.
 *
 * Usage:
 *   node scripts/approveLegacyAdminExpenses.js            # dry run, no writes
 *   node scripts/approveLegacyAdminExpenses.js --apply    # approve legacy rows
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import AdminExpense from '../models/AdminExpense.js';

const APPLY = process.argv.includes('--apply');

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  const pending = await AdminExpense.find({ status: 'pending' });
  console.log(`Pending administrative expenses found: ${pending.length}`);

  const samples = [];
  let updated = 0;

  for (const exp of pending) {
    if (samples.length < 15) {
      samples.push(
        `  ${exp.department} · "${exp.title}" · ₹${(Number(exp.amount) || 0).toFixed(0)} · ${new Date(exp.date).toISOString().slice(0, 10)}`
      );
    }
    updated++;

    if (APPLY) {
      exp.status = 'approved';
      // Preserve the audit fields if already set; otherwise stamp from history.
      exp.approvedAt = exp.approvedAt || exp.updatedAt || exp.createdAt || new Date();
      await exp.save();
    }
  }

  if (samples.length > 0) {
    console.log('\nSamples:');
    console.log(samples.join('\n'));
  }
  console.log(
    `\n${APPLY ? 'Approved' : 'Would approve'}: ${updated} legacy expense(s).`
  );
  if (!APPLY && updated > 0) {
    console.log('Dry run only — re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
