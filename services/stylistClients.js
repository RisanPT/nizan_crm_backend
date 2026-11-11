import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Consultation from '../models/Consultation.js';
import Lead from '../models/Lead.js';
import StylistClient, { generateClientNo } from '../models/StylistClient.js';
import { numberCalls, snapshotFromTeamN } from '../utils/stylistClientRules.js';

// Shared by the consultation and client controllers and the migration script.

const LEAD_SNAPSHOT_FIELDS = 'name phone email alternateNumber eventType eventDate location address district bookingId';
const BOOKING_SNAPSHOT_FIELDS =
  'bookingNumber customerName phone email secondaryContact selectedDates bookingDate eventSlot address district culture service outfitDetails assignedStaff bookingItems leadId';

const isId = (v) => v != null && mongoose.Types.ObjectId.isValid(String(v));

/// Loads the lead and booking behind a Team N client. Either id may be
/// missing: a booking made without a lead, or a lead not yet booked. The
/// lead's own booking is used when no booking id is given.
export const loadTeamNSource = async ({ leadId = null, bookingId = null }) => {
  const lead = isId(leadId) ? await Lead.findById(leadId).select(LEAD_SNAPSHOT_FIELDS).lean() : null;
  const bookingRef = isId(bookingId) ? bookingId : lead?.bookingId;
  const booking = isId(bookingRef)
    ? await Booking.findById(bookingRef).select(BOOKING_SNAPSHOT_FIELDS).lean()
    : null;
  // A booking found on its own may still point back at its lead.
  const linkedLead =
    lead ?? (isId(booking?.leadId) ? await Lead.findById(booking.leadId).select(LEAD_SNAPSHOT_FIELDS).lean() : null);
  return { lead: linkedLead, booking };
};

/// The existing client file for this Team N lead or booking, if there is one.
export const findTeamNClient = async ({ leadId = null, bookingId = null }) => {
  const or = [];
  if (isId(leadId)) or.push({ leadId });
  if (isId(bookingId)) or.push({ bookingId });
  if (or.length === 0) return null;
  return StylistClient.findOne({ $or: or });
};

/// Creates a client file, retrying if the random client number clashes.
export const createClientFile = async (fields) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await new StylistClient({ ...fields, clientNo: generateClientNo() }).save();
    } catch (err) {
      if (!(err?.code === 11000 && err?.keyPattern?.clientNo)) throw err;
    }
  }
  throw new Error('Could not allocate a client number');
};

/// The Team N client file for [leadId]/[bookingId], creating it (filled in
/// from the lead and booking) when it doesn't exist yet. Returns
/// { client, created } or null when neither the lead nor the booking exists.
export const findOrCreateTeamNClient = async ({ leadId = null, bookingId = null, stylistId, user }) => {
  const { lead, booking } = await loadTeamNSource({ leadId, bookingId });
  if (!lead && !booking) return null;

  const existing = await findTeamNClient({ leadId: lead?._id, bookingId: booking?._id });
  if (existing) return { client: existing, created: false };

  const client = await createClientFile({
    company: 'Team N',
    leadId: lead?._id ?? null,
    bookingId: booking?._id ?? null,
    ...snapshotFromTeamN(lead, booking),
    syncedAt: new Date(),
    stylistId,
    createdBy: user?._id ?? null,
    createdByName: user?.name ?? '',
  });
  return { client, created: true };
};

/// Re-fills a Team N client file from its lead and booking (a date moved, an
/// artist was assigned…). Fields the stylist owns — notes, status, required
/// calls, stylist — are kept. Returns false when the source is gone.
export const refreshTeamNClient = async (client) => {
  const { lead, booking } = await loadTeamNSource({ leadId: client.leadId, bookingId: client.bookingId });
  if (!lead && !booking) return false;
  const snap = snapshotFromTeamN(lead, booking);
  // Never blank out a value the source no longer has (e.g. a booking removed).
  for (const [k, v] of Object.entries(snap)) {
    const empty = Array.isArray(v) ? v.length === 0 : v === '';
    if (!empty) client[k] = v;
  }
  if (lead && !client.leadId) client.leadId = lead._id;
  if (booking) client.bookingId = booking._id;
  client.syncedAt = new Date();
  await client.save();
  return true;
};

/// Re-numbers one client's calls after any change to the series (a new call,
/// a reschedule that changes the order, a cancellation or a no-show). Only the
/// calls whose number actually changed are written.
export const renumberClientCalls = async (clientId) => {
  if (!isId(clientId)) return;
  const calls = await Consultation.find({ clientId }).select('_id status scheduledAt callNumber').lean();
  const numbers = numberCalls(calls);
  const ops = calls
    .filter((c) => (c.callNumber ?? null) !== numbers.get(String(c._id)))
    .map((c) => ({
      updateOne: { filter: { _id: c._id }, update: { $set: { callNumber: numbers.get(String(c._id)) } } },
    }));
  if (ops.length) await Consultation.bulkWrite(ops);
};
