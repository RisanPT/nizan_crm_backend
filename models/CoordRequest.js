import mongoose from 'mongoose';
import { DEPARTMENTS, PRIORITIES, REQUEST_STATUSES } from '../utils/marketingCoordinationStats.js';

// A coordination request in the Marketing ERP (Coordinations → Requests & Tasks, Inter-Department): one team asks another for
// something. kind 'handover' is the same record shown on the Inter-Department board by stage. The status machine and every figure
// are defined in utils/marketingCoordinationStats.js; the requester and the assignee are marketing team members (an assignee outside
// Marketing is typed as a name). Typed once: the Overview, the board and the reports all read this record.

const coordRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['request', 'handover'], default: 'request' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    detail: { type: String, default: '', trim: true, maxlength: 2000 },
    fromDept: { type: String, enum: DEPARTMENTS, required: true },
    toDept: { type: String, enum: DEPARTMENTS, required: true },
    requestedById: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    requestedByName: { type: String, default: '', trim: true, maxlength: 100 }, // when the requester is not a team member (an admin)
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    assigneeName: { type: String, default: '', trim: true, maxlength: 100 }, // a person outside the marketing team
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    dueDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ }, // IST day
    status: { type: String, enum: REQUEST_STATUSES, default: 'open' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    closedAt: { type: Date, default: null }, // set when completed or cancelled
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

coordRequestSchema.index({ createdAt: -1 });
coordRequestSchema.index({ status: 1, dueDate: 1 });
coordRequestSchema.index({ assigneeId: 1, status: 1 });
coordRequestSchema.index({ kind: 1, status: 1 });

export default mongoose.model('CoordRequest', coordRequestSchema);
