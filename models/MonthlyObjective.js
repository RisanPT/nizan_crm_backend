import mongoose from 'mongoose';
import { PRIORITIES, RESULTS, KR_KINDS } from '../utils/monthlyObjectives.js';

// One department's objective for one month, with its key results. Separate from the company OKRs (models/OKR.js): those are
// open-ended and the Objectives view lists every one of them, so a monthly objective stored there would bury it.
//
// The department is referenced by id (a rename does not orphan it) with its name and key kept alongside for display.
// year / month are the IST calendar month the objective is for.

const checkInSchema = new mongoose.Schema(
  {
    value: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
  },
  { _id: false }
);

const keyResultSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    // number (a count to reach) | percent (out of 100) | yesno (done or not). Older key results have none: they are numbers.
    kind: { type: String, enum: KR_KINDS, default: 'number' },
    metric: { type: String, default: '' },
    unit: { type: String, default: '' },
    targetValue: { type: Number, required: true, min: 0 },
    currentValue: { type: Number, default: 0, min: 0 },
    completed: { type: Boolean, default: false },
    // who finished it and when (cleared if it is put back to open). Not set for one that reached its target on its own at creation.
    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedByName: { type: String, default: '' },
    checkIns: { type: [checkInSchema], default: [] },
  },
  { _id: false }
);

// A change made to the plan after its month had started: what changed, and why (kept so a re-scope is not silent).
const changeSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    reason: { type: String, default: '', maxlength: 500 },
    summary: { type: [String], default: [] },
  },
  { _id: false }
);

// An objective that takes several months: where the run starts and where it is planned to finish (each a calendar month).
const spanSchema = new mongoose.Schema({ startYear: Number, startMonth: Number, endYear: Number, endMonth: Number }, { _id: false });

const monthlyObjectiveSchema = new mongoose.Schema(
  {
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    departmentName: { type: String, default: '' },
    departmentKey: { type: String, default: '' },

    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },

    objective: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    order: { type: Number, default: 0 },

    // Who is on the hook — an Employee, with the name kept for display.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    ownerName: { type: String, default: '' },

    keyResults: { type: [keyResultSchema], default: [] },
    span: { type: spanSchema, default: undefined },
    changes: { type: [changeSchema], default: [] },

    // Month-end close-out. No result = still open.
    result: { type: String, enum: [...RESULTS, null], default: null },
    resultNote: { type: String, default: '', maxlength: 1000 },
    closedAt: { type: Date, default: null },
    // How far it had got when it was closed, and whether the result differs from what that progress points to (then it has a note).
    progressAtClose: { type: Number, default: null },
    overridden: { type: Boolean, default: false },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Carry-over: this one was carried FROM an earlier month's objective / INTO a later month's.
    carriedFromId: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyObjective', default: null },
    carriedToId: { type: mongoose.Schema.Types.ObjectId, ref: 'MonthlyObjective', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

monthlyObjectiveSchema.index({ departmentId: 1, year: 1, month: 1 });
monthlyObjectiveSchema.index({ year: 1, month: 1 });

export default mongoose.model('MonthlyObjective', monthlyObjectiveSchema);
