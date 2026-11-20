import mongoose from 'mongoose';

// The CRM team's rules, one record: the time limits work is measured against and the thresholds the figures use. (New work is
// not handed out automatically: the CRM Head assigns it.) Read with getCrmSettings() (services/crmSettings.js); the CRM Head / management changes them.

const crmSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'crm', unique: true },
    // how fast a booking request should be decided
    requestSlaHours: { type: Number, default: 24, min: 1 },
    // how fast a client in the chat should get a first answer, and when an unanswered chat counts as left waiting
    chatResponseSlaMins: { type: Number, default: 60, min: 1 },
    chatUnansweredHours: { type: Number, default: 4, min: 1 },
    // time limit of a case, by kind (hours)
    caseSlaHours: {
      complaint: { type: Number, default: 48, min: 1 },
      follow_up: { type: Number, default: 72, min: 1 },
      re_engagement: { type: Number, default: 168, min: 1 },
      trial_follow_up: { type: Number, default: 72, min: 1 },
    },
    // an NPS at or under this is a detractor whose review opens a complaint
    lowNps: { type: Number, default: 6, min: 0, max: 10 },
    // a trial counts as converted when the client books within this many days of it; a re-engagement call as won likewise
    trialConversionDays: { type: Number, default: 60, min: 1 },
    reEngagementWinDays: { type: Number, default: 90, min: 1 },
    // the weekly report's customer-support target: different clients handled in a month
    monthlyCustomerTarget: { type: Number, default: 100, min: 1 },
    // when the CRM figures started being recorded — figures for earlier dates are partial
    trackingSince: { type: Date, default: Date.now },
    // when the per-booking ticks (verified, photos) and medical notes began (models/CrmBookingCare.js) — the weekly report says "—" before
    careSince: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const CrmSettings = mongoose.model('CrmSettings', crmSettingsSchema);
export default CrmSettings;
