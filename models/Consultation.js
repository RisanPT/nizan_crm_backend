import mongoose from 'mongoose';
import { istDayKey } from '../utils/istDate.js';
import {
  CONSULTATION_MODES,
  CONSULTATION_STATUSES,
  DEFAULT_DURATION_MINS,
  MEETING_PROVIDERS,
  TEXT_LIMITS,
} from '../utils/consultationRules.js';

// ── Consultation Number Generator ───────────────────────────────────────────
// CN-YYMMDD-NNNN (IST date). The suffix is random, so the unique index is the
// real guard; the controller retries on a duplicate.
export const generateConsultationNo = () => {
  const prefix = istDayKey(new Date()).slice(2).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `CN-${prefix}-${suffix}`;
};

// A reference photo attached to a consultation. `publicId` lets us delete it
// from Cloudinary when it is removed.
const referenceImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    caption: { type: String, default: '', maxlength: TEXT_LIMITS.caption },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// One entry per state change — the audit trail for the consultation (who,
// when, what changed). Notes content is never copied here, only field names.
const historySchema = new mongoose.Schema(
  {
    action: { type: String, required: true }, // Scheduled | Rescheduled | Reassigned | Updated | Completed | Cancelled | No-show
    status: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    reason: { type: String, default: '' },
    fromAt: { type: Date, default: null },
    toAt: { type: Date, default: null },
    fromStylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    toStylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    fields: { type: [String], default: [] },
    overrodeConflict: { type: Boolean, default: false },
  },
  { _id: false }
);

const consultationSchema = new mongoose.Schema(
  {
    consultationNo: {
      type: String,
      unique: true,
    },
    // The client file this call belongs to. Every new call has one; calls
    // made before client files existed get one from
    // scripts/migrateConsultationClients.js.
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StylistClient',
      default: null,
      index: true,
    },
    // Position in the client's series (1, 2, 3…). Null for a cancelled call or
    // a no-show, which don't count. Kept in step by renumberClientCalls().
    callNumber: { type: Number, default: null },
    // The Team N lead. Empty for a Nizan client (they aren't in the CRM).
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      default: null,
      index: true,
    },
    // The responsible stylist (a login user, like Lead.assignedTo).
    stylistId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    scheduledAt: { type: Date, required: true },
    durationMins: { type: Number, default: DEFAULT_DURATION_MINS },
    // Derived from scheduledAt + durationMins; stored so overlap checks are a
    // single indexed range query.
    endsAt: { type: Date, required: true },
    status: {
      type: String,
      enum: CONSULTATION_STATUSES,
      default: 'Scheduled',
    },
    mode: {
      type: String,
      enum: CONSULTATION_MODES,
      default: 'Video',
    },
    // Staff paste a Meet / Zoom link; the platform is detected from it.
    meetingProvider: {
      type: String,
      enum: ['', ...MEETING_PROVIDERS],
      default: '',
    },
    meetingLink: { type: String, default: '' },
    location: { type: String, default: '', maxlength: TEXT_LIMITS.location },

    // Sensitive: redacted for anyone who is not the assigned stylist or granted
    // consultations.notes (see consultationRules.redactConsultation).
    notes: { type: String, default: '', maxlength: TEXT_LIMITS.notes },
    preferences: { type: String, default: '', maxlength: TEXT_LIMITS.preferences },
    nextSteps: { type: String, default: '', maxlength: TEXT_LIMITS.nextSteps },
    // After-call details: what we told the client and the look agreed on.
    conveyed: { type: String, default: '', maxlength: TEXT_LIMITS.conveyed },
    lookMakeup: { type: String, default: '', maxlength: TEXT_LIMITS.lookMakeup },
    lookHair: { type: String, default: '', maxlength: TEXT_LIMITS.lookHair },
    lookOutfit: { type: String, default: '', maxlength: TEXT_LIMITS.lookOutfit },
    skinNotes: { type: String, default: '', maxlength: TEXT_LIMITS.skinNotes },
    // Photos the client shared (stored on Cloudinary; only the link is kept).
    referenceImages: { type: [referenceImageSchema], default: [] },

    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    rescheduleCount: { type: Number, default: 0 },

    // Invitation to the bride (click-to-chat). Stamped when staff mark the
    // invite as sent.
    inviteSentAt: { type: Date, default: null },
    inviteChannel: { type: String, default: '' },
    // Reminder keys already raised (e.g. '24h', '1h') so a sweep never repeats.
    remindersSent: { type: [String], default: [] },

    history: { type: [historySchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

consultationSchema.pre('validate', function setDerived(next) {
  if (!this.consultationNo) this.consultationNo = generateConsultationNo();
  if (this.scheduledAt && this.durationMins) {
    this.endsAt = new Date(this.scheduledAt.getTime() + this.durationMins * 60000);
  }
  next();
});

// Stylist schedule / conflict lookups and calendar range queries.
consultationSchema.index({ stylistId: 1, scheduledAt: 1 });
consultationSchema.index({ status: 1, scheduledAt: 1 });
consultationSchema.index({ leadId: 1, scheduledAt: -1 });

const Consultation = mongoose.model('Consultation', consultationSchema);

export default Consultation;
