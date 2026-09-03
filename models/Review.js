import mongoose from 'mongoose';

const RATING_KEYS_BRIDE = [
  'overall',
  'makeup',
  'hair',
  'saree',
];
const TEAM_BEHAVIOUR_KEYS = [
  'punctuality',
  'professionalism',
  'communication',
  'politeness',
  'handlingRequests',
];
const TEAM_MEMBER_KEYS = [
  'skill',
  'attention',
  'timeManagement',
  'professionalism',
  'communication',
  'overall',
];

// A post-service client review, requested when a booking is completed. Created
// (pending) at completion with an opaque token; the bride fills the public
// form and it becomes `submitted`. The internal management block is filled by
// staff afterwards. Mirrors the docx "Bridal Service Review Form".
const reviewSchema = mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },

    // Snapshot of the booking at send time (so the form is self-contained).
    booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },
    bookingNumber: { type: String, default: '' },
    brideName: { type: String, default: '' },
    weddingDate: { type: Date, default: null },
    venue: { type: String, default: '' },
    artistName: { type: String, default: '' }, // primary assigned artist (lead)
    artistNames: { type: [String], default: [] }, // all assigned names (reference)
    // All assigned team members with their role (artist + assistants), shown on
    // the form so the bride sees exactly who served her.
    teamMembers: {
      type: [
        {
          _id: false,
          name: { type: String, default: '' },
          role: { type: String, default: '' },
        },
      ],
      default: [],
    },
    customerPhone: { type: String, default: '' },

    // Lifecycle
    status: {
      type: String,
      enum: ['pending', 'submitted', 'expired'],
      default: 'pending',
      index: true,
    },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sentByName: { type: String, default: '' },
    sentVia: { type: String, default: 'whatsapp' },
    sentAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },

    // ── Bride answers (ratings 1-5; 0 = N/A or unanswered) ──
    overall: { type: Number, default: 0 },
    makeup: { type: Number, default: 0 },
    hair: { type: Number, default: 0 },
    saree: { type: Number, default: 0 },
    teamBehaviour: {
      punctuality: { type: Number, default: 0 },
      professionalism: { type: Number, default: 0 },
      communication: { type: Number, default: 0 },
      politeness: { type: Number, default: 0 },
      handlingRequests: { type: Number, default: 0 },
    },
    lookMatch: { type: String, default: '' }, // much_better|exactly|mostly|not
    comfortable: { type: String, default: '' }, // definitely_yes|yes|not_completely|no
    recommend: { type: String, default: '' }, // definitely_yes|yes|maybe|no
    bookAgain: { type: String, default: '' }, // definitely_yes|yes|maybe|no
    likedMost: { type: String, default: '' },
    couldBeBetter: { type: String, default: '' },

    // ── Team-member answers (ratings 1-5) ──
    teamMember: {
      skill: { type: Number, default: 0 },
      attention: { type: Number, default: 0 },
      timeManagement: { type: Number, default: 0 },
      professionalism: { type: Number, default: 0 },
      communication: { type: Number, default: 0 },
      overall: { type: Number, default: 0 },
    },
    teamMemberDidWell: { type: String, default: '' },
    teamMemberImprove: { type: String, default: '' },

    // ── Testimonial & marketing consent ──
    testimonial: { type: String, default: '' },
    marketingConsent: { type: Boolean, default: false },
    tagConsent: { type: Boolean, default: false },
    instagram: { type: String, default: '' },

    // ── NPS (0-10) ──
    nps: { type: Number, default: null },

    // ── Internal — management only ──
    brideScore: { type: Number, default: 0 }, // auto-avg /5
    teamMemberScore: { type: Number, default: 0 }, // auto-avg /5
    complaint: { type: Boolean, default: false },
    compliment: { type: Boolean, default: false },
    followUpRequired: { type: Boolean, default: false },
    reviewPosted: { type: Boolean, default: false },
    referralOpportunity: { type: Boolean, default: false },
    managerComments: { type: String, default: '' },
  },
  { timestamps: true },
);

// Average of the provided (non-zero) ratings, rounded to 1 decimal.
const avg = (values) => {
  const nums = values.filter((v) => Number(v) > 0);
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, v) => s + Number(v), 0) / nums.length) * 10) / 10;
};

// Recompute the internal scores from the submitted answers.
reviewSchema.methods.computeScores = function computeScores() {
  const bride = [
    ...RATING_KEYS_BRIDE.map((k) => this[k]),
    ...TEAM_BEHAVIOUR_KEYS.map((k) => this.teamBehaviour?.[k]),
  ];
  this.brideScore = avg(bride);
  this.teamMemberScore = avg(TEAM_MEMBER_KEYS.map((k) => this.teamMember?.[k]));
};

const Review = mongoose.model('Review', reviewSchema);

export default Review;
export { RATING_KEYS_BRIDE, TEAM_BEHAVIOUR_KEYS, TEAM_MEMBER_KEYS };
