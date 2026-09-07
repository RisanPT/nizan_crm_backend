import mongoose from 'mongoose';

// The five pillars of the company principle (Jasim Rasheed): Learnability,
// Responsibility, Punctuality, Commitment, Leadership. Each scored 0–5.
export const PILLARS = [
  'learnability',
  'responsibility',
  'punctuality',
  'commitment',
  'leadership',
];

const score = { type: Number, default: 0, min: 0, max: 5 };

// A monthly 5-pillar evaluation of ONE employee by a dept-head / HR / admin.
// Standalone scorecard (no automatic pay linkage). One row per employee/month
// (upserted). Punctuality is prefilled from attendance but stored as a snapshot
// so history stays stable even though attendance is read from an external system.
const performanceEvaluationSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please specify the employee'],
      index: true,
    },
    employeeName: { type: String, default: '' },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
      index: true,
    },
    department: { type: String, default: '' },

    // Evaluation period.
    month: { type: Number, required: true, min: 1, max: 12 }, // 1–12
    year: { type: Number, required: true },

    // The five pillar scores (0–5).
    learnability: score,
    responsibility: score,
    punctuality: score,
    commitment: score,
    leadership: score,
    // How punctuality was set — 'auto' (from attendance %) or 'manual'.
    punctualitySource: {
      type: String,
      enum: ['auto', 'manual'],
      default: 'manual',
    },
    // Mean of the five pillars (0–5), computed on save.
    composite: { type: Number, default: 0, min: 0, max: 5 },

    notes: { type: String, default: '', trim: true },

    evaluatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    evaluatorName: { type: String, default: '' },
  },
  { timestamps: true }
);

// One evaluation per employee per month (upsert target).
performanceEvaluationSchema.index(
  { employeeId: 1, year: 1, month: 1 },
  { unique: true }
);

performanceEvaluationSchema.pre('save', function computeComposite(next) {
  const vals = PILLARS.map((p) => Number(this[p]) || 0);
  this.composite =
    Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  next();
});

const PerformanceEvaluation = mongoose.model(
  'PerformanceEvaluation',
  performanceEvaluationSchema
);

export default PerformanceEvaluation;
