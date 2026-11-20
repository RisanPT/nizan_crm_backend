import mongoose from 'mongoose';

export const LEAD_PRIORITIES = ['Hot', 'Warm', 'Nurture', 'Cold'];

const leadSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
    },
    phone: {
      type: String,
      required: [true, 'Please add a phone number'],
      trim: true,
      // Phone numbers get typed with spaces and dashes ("70341 09552"), which
      // breaks equality checks and lead↔booking matching. Normalise on write.
      set: (v) => String(v ?? '').replace(/\s+/g, '').trim(),
    },
    source: {
      type: String,
      default: 'WhatsApp (Organic)',
    },
    // Marketing campaign this lead is attributed to — drives campaign ROI
    // (revenue from this lead's bookings rolls up to the campaign).
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      default: null,
    },
    location: {
      type: String,
      default: '',
    },
    leadType: {
      type: String,
      default: 'Individual',
    },
    // Event Type replaces the free-text Lead Type in the UI (Wedding, Reception, …).
    eventType: {
      type: String,
      default: '',
    },
    // Optional secondary contact number. Normalised like `phone` so search and
    // duplicate checks can match on either number.
    alternateNumber: {
      type: String,
      default: '',
      trim: true,
      set: (v) => String(v ?? '').replace(/\s+/g, '').trim(),
    },
    // Manually set date when the lead was actually received (can be past)
    leadDate: {
      type: Date,
      // No default — so existing docs without this field return null,
      // and Flutter correctly falls back to createdAt.
    },
    enquiryDate: {
      type: Date,
      default: Date.now,
    },
    // When the booking was MADE (the booking form's "Booking Date (when
    // booked)", i.e. the booking's createdAt). Set on conversion.
    bookedDate: {
      type: Date,
      default: null,
    },
    // The converted booking's EVENT (service) date — kept separate from
    // bookedDate so lead cards can show both. Resynced when the booking is
    // rescheduled.
    eventDate: {
      type: Date,
      default: null,
    },
    // Tentative event date for a customer who hasn't fixed the exact day yet
    // ("probably mid-April"). Set by sales; shown in the Lead Calendar.
    probableDate: {
      type: Date,
      default: null,
    },
    // Set automatically when a booking is created for this lead's phone
    // number, so a converted lead links straight to the work it produced.
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    // Geography copied from the booking on conversion, so lead reporting can
    // be sliced by district / region / pincode using confirmed address data.
    address: { type: String, default: '' },
    pincode: { type: String, default: '' },
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      default: null,
    },
    region: { type: String, default: '' },
    district: { type: String, default: '' },
    // ── Marketing details (all optional; rules in utils/marketGeo.js, applied by services/leadMarkets.js) ──
    // Where the bride is: Country → City from the marketing list. The names are copied from the list on every save, so a rename of a
    // country / city is cascaded to its leads (controllers/countryController.js) and a lead never names a place its ids do not.
    countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', default: null },
    country: { type: String, default: '' },
    cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City', default: null },
    city: { type: String, default: '' },
    // WhatsApp number when it is not the phone number ('' = the same as the phone).
    whatsapp: { type: String, default: '', trim: true },
    // What she can spend, in `budgetCurrency` (the country's currency unless set). null = not asked / not told.
    budget: { type: Number, default: null, min: 0 },
    budgetCurrency: { type: String, default: '', trim: true },
    language: { type: String, default: '', trim: true },
    // Who referred her (free text until the Partner CRM exists) and the ad creative she came from (e.g. "Reel #17").
    referralPartner: { type: String, default: '', trim: true },
    creative: { type: String, default: '', trim: true },
    // Date + time for follow-up reminder (only when status is Follow-up)
    followUpDate: {
      type: Date,
    },
    // How many times a follow-up has been scheduled for this lead. Incremented
    // server-side whenever a new/changed follow-up date is saved.
    followUpCount: {
      type: Number,
      default: 0,
    },
    // How many scheduled follow-ups were actioned (lead moved off the Follow-up
    // stage while a follow-up was pending). Powers the "Completed" dashboard widget.
    followUpCompletedCount: {
      type: Number,
      default: 0,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Who ENTERED this lead (distinct from assignedTo, which can be reassigned).
    // createdByName is denormalised so reports need no join and survive renames.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdByName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: [
        'New',
        'Contacted',
        'Qualified',
        'Follow-up',
        'Pending Lost Approval',
        'Lost',
        'Converted',
      ],
      default: 'New',
    },
    // How likely this lead is to close — tracked separately from the pipeline
    // stage so a lead can be, say, "Follow-up" AND "Hot" at the same time.
    // Nurture = interested but a long way off (keep in touch). The Marketing
    // screens read a lead with no priority as "Not rated" (utils/marketingLeadStages.js).
    priority: {
      type: String,
      enum: LEAD_PRIORITIES,
      default: 'Warm',
    },
    reason: {
      type: String,
      default: '',
    },
    remarks: {
      type: String,
      default: '',
    },
    // ── Lost-approval workflow ──────────────────────────────────────────────
    // A Sales Executive who marks a lead Lost does NOT close it; the lead moves
    // to 'Pending Lost Approval' until a Sales/Regional Manager (or Admin)
    // approves or rejects it. These fields capture the request + the decision.
    competitorName: {
      type: String,
      default: '',
    },
    lostAttachment: {
      type: String,
      default: '',
    },
    // The stage the lead was in before the lost request, so a rejection can
    // restore it instead of guessing.
    previousStatus: {
      type: String,
      default: '',
    },
    lostRequestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lostRequestedAt: {
      type: Date,
      default: null,
    },
    lostReviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lostReviewedAt: {
      type: Date,
      default: null,
    },
    lostDecision: {
      type: String,
      enum: ['', 'approved', 'rejected'],
      default: '',
    },
    lostReviewNote: {
      type: String,
      default: '',
    },
    // Append-only trail of notable actions on this lead (lost requested,
    // approved, rejected, …) for the acceptance-criteria audit log.
    // Where the lead came in from on its own — '' = typed in by staff. Speed to lead is measured on these (utils/leadResponse.js).
    origin: { type: String, enum: ['', 'meta_lead_ads', 'website', 'whatsapp'], default: '' },
    // The first contact: the first call / message / follow-up logged on it, or its first move out of New. Set once, by the server.
    firstContactAt: { type: Date, default: null },
    firstContactBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    firstContactByName: { type: String, default: '' },
    firstContactVia: { type: String, default: '' },
    // The "a new lead is waiting" alert went out (once per lead).
    responseAlertAt: { type: Date, default: null },
    auditLog: [
      {
        action: { type: String, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        byName: { type: String, default: '' },
        note: { type: String, default: '' },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// the waiting-lead check: new leads not yet contacted, newest first
leadSchema.index({ status: 1, firstContactAt: 1, createdAt: -1 });

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
