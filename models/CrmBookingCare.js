import mongoose from 'mongoose';

// What the CRM team does for ONE booking around its work days — kept apart from the booking itself, so the general booking routes (which
// sales, accounts and the apps read) never carry a client's medical notes, and an older app saving the whole booking cannot wipe them.
//
//   • verifications — "verified with the client": the CRM called about a work day (date, time, venue, look) and ticked it. One per day.
//   • photos        — "photos collected" for a work day that is done. One per day.
//   • medical       — the client's conditions the artists must know (allergy, skin condition, pregnancy, other) and a note.
//   • emergencies   — a medical emergency during a work: when, what happened, what was done.
// Read and written through /api/crm/care (controllers/crmCareController.js); the weekly report counts them (services/crmWeekly.js).

export const MEDICAL_CONDITIONS = ['allergy', 'skin', 'pregnancy', 'other'];

const dayMark = new mongoose.Schema(
  {
    day: { type: String, required: true }, // 'YYYY-MM-DD' (IST) — the work day
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 500 },
  },
  { _id: false }
);

const emergencySchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // the work day it happened on
    at: { type: Date, default: Date.now }, // when it was logged
    what: { type: String, required: true, maxlength: 1000 },
    action: { type: String, default: '', maxlength: 1000 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
  },
  { timestamps: false }
);

const crmBookingCareSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, unique: true },
    verifications: { type: [dayMark], default: [] },
    photos: { type: [dayMark], default: [] },
    medical: {
      conditions: { type: [{ type: String, enum: MEDICAL_CONDITIONS }], default: [] },
      note: { type: String, default: '', maxlength: 1000 },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      updatedByName: { type: String, default: '' },
    },
    emergencies: { type: [emergencySchema], default: [] },
  },
  { timestamps: true }
);

// the weekly report: which bookings have a medical condition / an emergency on a day
crmBookingCareSchema.index({ 'medical.conditions': 1 });
crmBookingCareSchema.index({ 'emergencies.day': 1 });

const CrmBookingCare = mongoose.model('CrmBookingCare', crmBookingCareSchema);
export default CrmBookingCare;
