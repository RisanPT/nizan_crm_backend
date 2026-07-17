import mongoose from 'mongoose';

// ── Trial Number Generator ──────────────────────────────────────────────────
const generateTrialNumber = () => {
  const now = new Date();
  const datePrefix = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const randomSuffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `TR-${datePrefix}-${randomSuffix}`;
};

// ── Trial Item Sub-schema ───────────────────────────────────────────────────
// Completely independent of the Package catalog — free-text only.
const trialItemSchema = new mongoose.Schema(
  {
    packageName: {
      type: String,
      default: '',
    },
    lookLabel: {
      type: String,
      default: '',
    },
    notes: {
      type: String,
      default: '',
    },
    outcome: {
      type: String,
      enum: ['pending', 'approved', 'needs_revision', 'rejected'],
      default: 'pending',
    },
    price: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

// ── Assigned artist sub-schema (mirrors booking assignment) ──────────────────
const trialAssignmentSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    artistName: { type: String, default: '' },
    phone: { type: String, default: '' },
    roleType: { type: String, default: 'artist' }, // artist | lead | assistant
    type: { type: String, default: '' },
  },
  { _id: false }
);

// ── Trial Schema ────────────────────────────────────────────────────────────
const trialSchema = new mongoose.Schema(
  {
    trialNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    clientName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
    },
    // Stored as YYYY-MM-DD string (same pattern as bookingDate)
    trialDate: {
      type: String,
      required: true,
    },
    startTime: {
      type: String,
      default: '',
    },
    endTime: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'postponed', 'cancelled'],
      default: 'scheduled',
    },
    notes: {
      type: String,
      default: '',
    },
    // 1..N packages / looks tried during the appointment
    trialItems: {
      type: [trialItemSchema],
      default: [],
    },
    // Artists assigned to this trial (like a booking).
    assignedStaff: {
      type: [trialAssignmentSchema],
      default: [],
    },
    // Optional link to a parent Booking (leave null if not needed)
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
  },
  { timestamps: true }
);

// Auto-generate trialNumber before first save
trialSchema.pre('save', async function (next) {
  if (!this.trialNumber) {
    let candidate = generateTrialNumber();
    // Retry on collision (very unlikely)
    while (await mongoose.models.Trial.exists({ trialNumber: candidate })) {
      candidate = generateTrialNumber();
    }
    this.trialNumber = candidate;
  }
  next();
});

const Trial = mongoose.model('Trial', trialSchema);
export default Trial;
