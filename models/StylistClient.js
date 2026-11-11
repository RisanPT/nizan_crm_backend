import mongoose from 'mongoose';
import { istDayKey } from '../utils/istDate.js';
import {
  CLIENT_COMPANIES,
  CLIENT_STATUSES,
  CLIENT_TEXT_LIMITS,
  DEFAULT_REQUIRED_CALLS,
  MAX_REQUIRED_CALLS,
  MIN_REQUIRED_CALLS,
} from '../utils/stylistClientRules.js';

// SC-YYMMDD-NNNN (IST date). The suffix is random, so the unique index is the
// real guard; the controller retries on a duplicate.
export const generateClientNo = () => {
  const prefix = istDayKey(new Date()).slice(2).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `SC-${prefix}-${suffix}`;
};

const text = (field) => ({ type: String, default: '', trim: true, maxlength: CLIENT_TEXT_LIMITS[field] });

// A stylist's client file: who the client is, their event, and (through
// Consultation.clientId) every call in their series. Team N clients link to a
// CRM lead/booking and are filled in from them; Nizan clients are typed in.
const stylistClientSchema = new mongoose.Schema(
  {
    clientNo: { type: String, unique: true },
    company: { type: String, enum: CLIENT_COMPANIES, required: true, index: true },

    // Team N only. One client file per lead.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    syncedAt: { type: Date, default: null }, // last fill-in from the lead/booking

    name: { ...text('name'), required: true },
    phone: { ...text('phone'), required: true },
    altPhone: text('altPhone'),
    email: text('email'),

    eventType: text('eventType'),
    eventDates: { type: [String], default: [] }, // 'YYYY-MM-DD' (IST), sorted
    eventSlot: text('eventSlot'),
    venue: text('venue'),
    district: text('district'),
    culture: text('culture'),
    packageName: text('packageName'),
    bookingNumber: text('bookingNumber'),
    artistNames: { type: [String], default: [] },
    outfitDetails: text('outfitDetails'),
    notes: text('notes'),

    // The responsible stylist (a login user, like Consultation.stylistId).
    stylistId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: CLIENT_STATUSES, default: 'Active', index: true },
    requiredCalls: {
      type: Number,
      default: DEFAULT_REQUIRED_CALLS,
      min: MIN_REQUIRED_CALLS,
      max: MAX_REQUIRED_CALLS,
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

// One file per Team N lead (Nizan files have no lead).
stylistClientSchema.index(
  { leadId: 1 },
  { unique: true, partialFilterExpression: { leadId: { $type: 'objectId' } } }
);
stylistClientSchema.index({ stylistId: 1, status: 1, updatedAt: -1 });

const StylistClient = mongoose.model('StylistClient', stylistClientSchema);

export default StylistClient;
