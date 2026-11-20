import mongoose from 'mongoose';

// A development project (Strategies & Developments → Development Projects: "Website v2", "CRM & Lead Automation"…). Tasks
// (`MarketingTask.devProjectId`) are tied to it — "development projects show owner, progress, due date and status from linked tasks" —
// so what is stored here is only what a person decides: the owner, the dates, a hand-typed progress used ONLY while no task is tied to
// it, and the manager's status. Progress and status are COUNTED (utils/marketingStrategyStats.js). controllers/marketingStrategiesController.js
// owns this model. The project's due date is `endDate`.
export const DEV_PROJECT_STATUSES = ['planned', 'in_progress', 'on_hold', 'completed', 'cancelled'];

const devProjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    category: { type: String, default: '', trim: true, maxlength: 80 },
    status: { type: String, enum: DEV_PROJECT_STATUSES, default: 'in_progress' },
    startDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // — Strategies & Developments —
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    progress: { type: Number, default: null, min: 0, max: 100 }, // typed by the owner; counts only while no task is tied to the project
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    notes: { type: String, default: '', trim: true, maxlength: 2000 },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicPlan', default: null },
    completedAt: { type: Date, default: null }, // when it was marked completed by hand
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

devProjectSchema.index({ brand: 1, status: 1 });
devProjectSchema.index({ planId: 1 });

export default mongoose.model('DevProject', devProjectSchema);
