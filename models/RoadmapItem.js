import mongoose from 'mongoose';

// One line of the Quarterly Strategic Roadmap (Strategies & Developments → Roadmap): a milestone planned for a quarter of a year that
// members TICK OFF when it is done. The quarter's name ("Foundation", "Growth"…) is the `theme` the team types on its items. A line may
// point at a plan or an initiative it belongs to; ticking it records who did it and when (those feed "Recent Updates").
const roadmapItemSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true, min: 2000, max: 2100 },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    theme: { type: String, default: '', trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicPlan', default: null },
    initiativeId: { type: mongoose.Schema.Types.ObjectId, ref: 'StrategicInitiative', default: null },
    done: { type: Boolean, default: false },
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    doneByName: { type: String, default: '' },
    doneAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

roadmapItemSchema.index({ year: 1, quarter: 1 });

export default mongoose.model('RoadmapItem', roadmapItemSchema);
