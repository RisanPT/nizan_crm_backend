/**
 * One-time migration: give consultations made BEFORE client files existed a
 * client file, and number each client's calls (Call 1, 2, 3…).
 *
 * For every lead that has calls without a client file:
 *   • its Team N client file is found, or created from the lead and booking,
 *     owned by the stylist of the client's most recent call;
 *   • those calls are linked to it and numbered.
 * Calls with neither a lead nor a client are listed, never changed.
 *
 * DRY RUN by default — reads only, prints what it would do, changes nothing.
 * Idempotent: calls that already have a client file are left alone, so it is
 * safe to run again.
 *
 * Usage:
 *   node scripts/migrateConsultationClients.js            # dry run
 *   node scripts/migrateConsultationClients.js --apply    # make the changes
 *
 * It connects to MONGO_URI from .env — check the database it prints before
 * using --apply.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Consultation from '../models/Consultation.js';
import StylistClient from '../models/StylistClient.js';
import {
  findOrCreateTeamNClient,
  findTeamNClient,
  loadTeamNSource,
  renumberClientCalls,
} from '../services/stylistClients.js';
import { snapshotFromTeamN } from '../utils/stylistClientRules.js';

const APPLY = process.argv.includes('--apply');

const dbLabel = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.host}${u.pathname}`; // never print the credentials
  } catch {
    return '(unreadable MONGO_URI)';
  }
};

const main = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  console.log(`Database: ${dbLabel(uri)}`);
  console.log(APPLY ? 'Mode: APPLY — changes will be written\n' : 'Mode: dry run — nothing will be changed\n');
  await mongoose.connect(uri);

  const loose = await Consultation.find({ clientId: null })
    .select('_id leadId stylistId scheduledAt status')
    .sort({ scheduledAt: 1 })
    .lean();
  console.log(`Calls without a client file: ${loose.length}`);

  const byLead = new Map();
  const orphans = [];
  for (const c of loose) {
    if (!c.leadId) {
      orphans.push(c);
      continue;
    }
    const key = String(c.leadId);
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(c);
  }

  let created = 0;
  let reused = 0;
  let linked = 0;
  let missing = 0;
  for (const [leadId, calls] of byLead) {
    // Owner = the stylist of the latest call (they're the one working with them now).
    const owner = calls[calls.length - 1].stylistId;
    const existing = await findTeamNClient({ leadId });

    if (!APPLY) {
      if (existing) {
        console.log(`  would link ${calls.length} call(s) to existing client ${existing.clientNo} (${existing.name})`);
        reused += 1;
      } else {
        const { lead, booking } = await loadTeamNSource({ leadId });
        if (!lead && !booking) {
          console.log(`  lead ${leadId}: no longer exists — ${calls.length} call(s) left as they are`);
          missing += 1;
          continue;
        }
        const snap = snapshotFromTeamN(lead, booking);
        console.log(
          `  would create client "${snap.name}" (${snap.phone})` +
            `${snap.bookingNumber ? `, booking ${snap.bookingNumber}` : ''}` +
            `${snap.eventDates.length ? `, event ${snap.eventDates.join(', ')}` : ''} — ${calls.length} call(s)`
        );
        created += 1;
      }
      linked += calls.length;
      continue;
    }

    const found = existing
      ? { client: existing, created: false }
      : await findOrCreateTeamNClient({ leadId, stylistId: owner, user: { name: 'Migration' } });
    if (!found) {
      console.log(`  lead ${leadId}: no longer exists — ${calls.length} call(s) left as they are`);
      missing += 1;
      continue;
    }
    if (found.created) created += 1;
    else reused += 1;
    const r = await Consultation.updateMany(
      { _id: { $in: calls.map((c) => c._id) }, clientId: null },
      { $set: { clientId: found.client._id } }
    );
    linked += r.modifiedCount ?? 0;
    await renumberClientCalls(found.client._id);
    console.log(`  ${found.created ? 'created' : 'linked to'} ${found.client.clientNo} (${found.client.name}) — ${calls.length} call(s)`);
  }

  console.log('\nSummary');
  console.log(`  client files ${APPLY ? 'created' : 'to create'}: ${created}`);
  console.log(`  existing client files ${APPLY ? 'used' : 'to use'}: ${reused}`);
  console.log(`  calls ${APPLY ? 'linked' : 'to link'}: ${linked}`);
  console.log(`  leads that no longer exist (skipped): ${missing}`);
  console.log(`  calls with no lead (skipped): ${orphans.length}`);
  orphans.forEach((c) => console.log(`    ${c._id}  ${new Date(c.scheduledAt).toISOString()}  ${c.status}`));
  if (!APPLY) console.log('\nRun again with --apply to make these changes.');
  console.log(`\nClient files now in the database: ${await StylistClient.countDocuments()}`);
};

main()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
