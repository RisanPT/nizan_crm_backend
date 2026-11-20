import mongoose from 'mongoose';

// A strategic initiative (Strategies & Developments → Initiatives). Tasks (`MarketingTask.initiativeId`) and logs
// (`MarketingActivity.initiativeId`) are tied to it — "initiative progress comes from logged tasks tagged to that initiative" — so what
// is stored here is only what a person decides: who owns it, its dates, impact, a hand-typed progress that is used ONLY while no task
// is tied to it, and the manager's status. Progress, status, owner-from-tasks and hours are COUNTED, never stored:
// see utils/marketingStrategyStats.js. controllers/marketingStrategiesController.js owns this model.
export const INITIATIVE_STATUSES = ['planned', 'active', 'on_hold', 'completed', 'cancelled'];
export const IMPACTS = ['high', 'medium', 'low'];

const strategicInitiativeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    focusArea: { type: String, default: '', trim: true, maxlength: 120 },
    status: { type: String, enum: INITIATIVE_STATUSES, default: 'active' },
    dueDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // — Strategies & Developments —
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    startDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    impact: { type: String, enum: IMPACTS, default: 'medium' },
    // typed by the owner; counts only while no task is tied to the initiative (then the tasks decide). null = not set.
    progress: { type: Number, default: null, min: 0, max: 100 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    notes: { type: String, default: '', trim: true, maxlength: 2000 },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicPlan', default: null },
    completedAt: { type: Date, default: null }, // when it was marked completed by hand
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

strategicInitiativeSchema.index({ brand: 1, status: 1 });
strategicInitiativeSchema.index({ planId: 1 });

export default mongoose.model('StrategicInitiative', strategicInitiativeSchema);
