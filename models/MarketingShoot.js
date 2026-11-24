import mongoose from 'mongoose';

// A shoot plan in the Creative Portfolio (the marketing team's document: Shoot Planner → Production Calendar → Shoot Reports → Gallery).
// The plan is typed ONCE — brand, content pillar, date, crew, what it should produce — and every other screen reads it: the calendar
// shows it, the reports compare what was delivered against what was planned, the gallery's assets attach to it. Progress moves when
// members LOG work against the shoot (Log Activity → Shoot + stage), never by typing it twice.

export const SHOOT_STATUSES = ['planned', 'pre_production', 'in_production', 'post_production', 'completed', 'cancelled'];
// the five milestones a shoot passes through (the document's Brief → Pre-production → Production → Post-production → Distribution)
export const MILESTONE_KEYS = ['brief', 'pre_production', 'production', 'post_production', 'distribution'];
export const OUTPUT_KEYS = ['reels', 'stills', 'films', 'carousels', 'storyFrames', 'decks'];

// a crew line names a Marketing team member (memberId), a makeup artist from the staff list (employeeId), or just a name (a freelancer)
const crewSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    name: { type: String, default: '', trim: true, maxlength: 100 },
    role: { type: String, default: '', trim: true, maxlength: 80 },
  },
  { _id: false },
);

// one frame of the storyboard, in shooting order
const frameSchema = new mongoose.Schema(
  {
    shotNo: { type: String, default: '', trim: true, maxlength: 12 }, // "1", "2A" — the position when left blank
    description: { type: String, required: true, trim: true, maxlength: 500 },
    shotType: { type: String, default: '', trim: true, maxlength: 60 }, // Wide, Close-up, Detail, Drone…
    durationSec: { type: Number, default: 0, min: 0, max: 3600 },
    referenceUrl: { type: String, default: '', trim: true },
    imageUrl: { type: String, default: '', trim: true }, // the frame's picture (a sketch, a still, a moodboard picture)
    notes: { type: String, default: '', trim: true, maxlength: 500 },
    key: { type: String, default: '' }, // the frame's own id — a tick and an edit find it by this (utils/shootBoard.js)
    shotAt: { type: Date, default: null }, // ticked as filmed on the shoot day
    shotByName: { type: String, default: '' },
  },
  { _id: false },
);

// a picture, a video or a link on the moodboard or the camera movement plan
const referenceItemSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true, maxlength: 120 },
    url: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['image', 'video', 'link'], default: 'link' },
    addedByName: { type: String, default: '' },
    addedAt: { type: Date, default: null },
  },
  { _id: false },
);

// a PDF on the moodboard, the storyboard or the camera movement plan (a brief, a lookbook, a drawn storyboard, a shot list, the camera
// moves) — read in the app through the server
const documentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    part: { type: String, enum: ['moodboard', 'storyboard', 'camera'], required: true }, // camera = the camera movement plan
    name: { type: String, default: '', trim: true, maxlength: 160 }, // the file's name
    label: { type: String, default: '', trim: true, maxlength: 120 },
    fileUrl: { type: String, default: '' }, // where it is kept (never sent to the app — services/shootFiles.js)
    fileId: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    pages: { type: Number, default: null },
    addedByName: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const milestoneSchema = new mongoose.Schema(
  {
    key: { type: String, enum: MILESTONE_KEYS, required: true },
    date: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ }, // the day it is planned for
    doneAt: { type: Date, default: null }, // set when the work is logged (or marked done by hand)
  },
  { _id: false },
);

const plannedSchema = new mongoose.Schema(Object.fromEntries(OUTPUT_KEYS.map((k) => [k, { type: Number, default: 0, min: 0, max: 10000 }])), { _id: false });

const marketingShootSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    pillar: { type: String, default: '', trim: true, maxlength: 120 }, // content pillar: "Bridal · Transformation · Trust"
    category: { type: String, default: '', trim: true, maxlength: 80 }, // "Bridal Makeup", "Brand Content"…
    shootType: { type: String, default: 'Full Shoot', trim: true, maxlength: 60 },
    status: { type: String, enum: SHOOT_STATUSES, default: 'planned' },
    shootDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // IST day
    startTime: { type: String, default: '', match: /^(\d{2}:\d{2})?$/ },
    endTime: { type: String, default: '', match: /^(\d{2}:\d{2})?$/ },
    location: { type: String, default: '', trim: true, maxlength: 160 },
    crew: { type: [crewSchema], default: [] },
    brief: { objective: { type: String, default: '', maxlength: 1000 }, audience: { type: String, default: '', maxlength: 300 }, notes: { type: String, default: '', maxlength: 2000 } },
    planned: { type: plannedSchema, default: () => ({}) },
    milestones: { type: [milestoneSchema], default: [] },
    coverUrl: { type: String, default: '', trim: true },
    // the moodboard: pictures (uploaded or linked), videos and links — kind decided from the link (utils/shootBoard.js)
    references: { type: [referenceItemSchema], default: [] },
    // Camera Movement: reference pictures and video links of the moves (pan, dolly, gimbal…), the same kind of items (its PDFs: documents)
    cameraRefs: { type: [referenceItemSchema], default: [] },
    // Crew & Logistics: when the crew must be there, where (a map link), what to bring or arrange (ticked off), notes
    logistics: {
      callTime: { type: String, default: '', match: /^(\d{2}:\d{2})?$/ },
      mapUrl: { type: String, default: '', trim: true },
      notes: { type: String, default: '', maxlength: 1000 },
      checklist: { type: [{ text: { type: String, required: true, trim: true, maxlength: 160 }, done: { type: Boolean, default: false }, byName: { type: String, default: '' }, at: { type: Date, default: null }, _id: false }], default: [] },
    },
    storyboard: { type: [frameSchema], default: [] },
    documents: { type: [documentSchema], default: [] }, // PDFs on the moodboard / storyboard
    // the work (a CRM booking) the shoot covers, when it covers one — the booking's Content card reads the shoot through this
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    rescheduleCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

marketingShootSchema.index({ shootDate: 1, brand: 1 });
marketingShootSchema.index({ status: 1, shootDate: 1 });
marketingShootSchema.index({ bookingId: 1 });

export default mongoose.model('MarketingShoot', marketingShootSchema);
