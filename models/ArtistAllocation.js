import mongoose from 'mongoose';

// One work day of a booking package given to an artist team (services/artistAllocation.js): the slot it holds (M1, M2, E1 — or an
// EXTRA X1 that waits for the Artist Head's OK), what the ERP suggested and what the coordinator chose. The staff on the booking
// stays the truth of who works it; these rows keep the slots and the story, and are kept in step with the booking after every save.
// kind 'shadow' rows only note what the ERP would have suggested (the trial run before coordinators see suggestions).
const allocationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['allocation', 'shadow'], default: 'allocation' },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingNumber: { type: String, default: '' },
    customerName: { type: String, default: '' },
    unitKey: { type: String, required: true }, // 'b' — the booking; 'i:<n>' — its n-th package
    fingerprint: { type: String, default: '' }, // the package's service + days + start (a re-ordered package is noticed)
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    start: { type: String, default: '' },
    end: { type: String, default: '' },
    half: { type: String, enum: ['morning', 'evening'], default: 'morning' },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtistTeam', default: null },
    leadEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    assistantEmployeeIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }], default: [] },
    active: { type: Boolean, default: true },
    holdsSlot: { type: Boolean, default: false },
    slotKey: { type: String, default: '' }, // M1 M2 E1 … X1 X2
    extra: { type: Boolean, default: false },
    extraNo: { type: Number, default: null },
    overPlan: { type: Boolean, default: false }, // past the day's 20 — kept, flagged
    approval: {
      status: { type: String, enum: ['not_needed', 'pending', 'approved', 'rejected'], default: 'not_needed' },
      byName: { type: String, default: '' },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      note: { type: String, default: '' },
    },
    decision: { type: String, enum: ['accepted', 'override', 'manual', 'reconciled', 'auto'], default: 'accepted' }, // auto — the ERP gave it on its own
    suggestion: {
      topTeamId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtistTeam', default: null },
      chosenRank: { type: Number, default: null },
      tier: { type: String, default: '' },
      reason: { type: String, default: '' },
    },
    overrideReason: { type: String, default: '', maxlength: 200 },
    conflictsConfirmed: { type: [String], default: [] },
    source: { type: String, default: '' }, // requests | bulk | board | manage | create | reconcile | auto
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: '' },
    decidedAt: { type: Date, default: Date.now },
    releasedAt: { type: Date, default: null },
    releasedReason: { type: String, default: '' },
    shadow: {
      suggestedTeamId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtistTeam', default: null },
      actualTeamId: { type: mongoose.Schema.Types.ObjectId, ref: 'ArtistTeam', default: null },
      matched: { type: Boolean, default: null },
    },
  },
  { timestamps: true },
);

// the locks (no transactions on the server): a slot is held once; a day's extras are numbered 1..N once; a work day is allocated once
allocationSchema.index({ teamId: 1, day: 1, slotKey: 1 }, { unique: true, partialFilterExpression: { holdsSlot: true } });
allocationSchema.index({ day: 1, extraNo: 1 }, { unique: true, partialFilterExpression: { holdsSlot: true, extra: true } });
allocationSchema.index({ bookingId: 1, unitKey: 1, day: 1, kind: 1 }, { unique: true, partialFilterExpression: { active: true } });
allocationSchema.index({ day: 1, active: 1 });
allocationSchema.index({ kind: 1, decidedAt: 1 });

export default mongoose.model('ArtistAllocation', allocationSchema);
