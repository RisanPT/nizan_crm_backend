import mongoose from 'mongoose';
import { normalizePhone } from '../utils/phone.js';

// A bridal CLIENT identity for the client-facing app — deliberately separate
// from the staff `User` collection (which drives roles/permissions/scoping).
// Keyed by phone (last-10 digits), matching how Booking/Lead identify clients.
const clientUserSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      set: normalizePhone, // canonical last-10 digits
    },
    name: { type: String, default: '' },
    email: { type: String, default: '', lowercase: true, trim: true },
    // Linked CRM Customer (created lazily — Customer requires a unique email, so
    // phone-only clients stay unlinked until they book or provide an email).
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    // Optional profile used by trust/glow features later (Modules A/C).
    communityTag: { type: String, default: '' },
    skinTone: { type: String, default: '' },
    // Survey answers from the preferences flow (question-id -> [selected]).
    preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Looks the bride saved to her Look Board (from the culture templates).
    savedLooks: {
      type: [
        {
          _id: false,
          id: { type: String, default: '' },
          look: { type: String, default: '' },
          culture: { type: String, default: '' },
        },
      ],
      default: [],
    },
    // The look the bride built per function (outfit / jewellery / hair / makeup),
    // grouped by tradition. Names are stored as shown so staff read them as-is.
    lookPlan: {
      type: [
        {
          _id: false,
          tradition: { type: String, default: '' },
          traditionName: { type: String, default: '' },
          function: { type: String, default: '' },
          picks: {
            type: [
              {
                _id: false,
                category: { type: String, default: '' },
                optionId: { type: String, default: '' },
                name: { type: String, default: '' },
              },
            ],
            default: [],
          },
        },
      ],
      default: [],
    },
    // Explicit consent to send a face photo to an AI provider for "preview on
    // me". `version` ties the consent to the exact wording she agreed to.
    faceConsent: {
      at: { type: Date, default: null },
      version: { type: String, default: '' },
    },
    // Per-day count of preview generations (cost control).
    tryOnUsage: {
      day: { type: String, default: '' }, // YYYY-MM-DD (UTC)
      count: { type: Number, default: 0 },
    },
    verifiedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
  },
  { timestamps: true }
);

const ClientUser = mongoose.model('ClientUser', clientUserSchema);
export default ClientUser;
