import mongoose from 'mongoose';

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
      default: 'Walk-in',
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
    bookedDate: {
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
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
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
    priority: {
      type: String,
      enum: ['Hot', 'Warm', 'Cold'],
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

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
