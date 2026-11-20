import mongoose from 'mongoose';
import { OVERRIDE_FIELDS, WEEKLY_SECTIONS } from '../utils/crmWeekly.js';

// The CRM team's WEEKLY REPORT for one week (Monday–Sunday, IST) — what the CRM Head types (starting messages, the manpower answers,
// notes) and, once submitted, the figures as they were then (`snapshot`), so a booking changed later does not change a report already
// handed in. The figures of a draft are worked out fresh each time (services/crmWeekly.js). Any figure can also be typed by hand
// (`typed.overrides`, with a note per item), and outside-artist works the records missed typed in (`typed.outsourceLines`).

const crmWeeklyReportSchema = new mongoose.Schema(
  {
    weekStart: { type: String, required: true, unique: true }, // the Monday, 'YYYY-MM-DD'
    typed: {
      startingMessagesNizan: { type: Number, default: null, min: 0 },
      startingMessagesTeamN: { type: Number, default: null, min: 0 },
      startingMessagesNote: { type: String, default: '' },
      manpowerPlan: { type: String, default: '' },
      enoughWork: { type: String, enum: ['', 'yes', 'no'], default: '' },
      enoughWorkNote: { type: String, default: '' },
      notes: { type: String, default: '' },
      overrides: Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f.key, { type: Number, default: null, min: 0 }])),
      sectionNotes: Object.fromEntries(WEEKLY_SECTIONS.map((k) => [k, { type: String, default: '' }])),
      outsourceLines: {
        type: [
          new mongoose.Schema(
            { bride: String, outsource: String, work: { type: String, default: '' }, phone: { type: String, default: '' }, day: { type: String, default: '' } },
            { _id: false }
          ),
        ],
        default: [],
      },
    },
    status: { type: String, enum: ['draft', 'submitted'], default: 'draft' },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    submittedByName: { type: String, default: '' },
    reopenedAt: { type: Date, default: null },
    reopenedByName: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const CrmWeeklyReport = mongoose.model('CrmWeeklyReport', crmWeeklyReportSchema);
export default CrmWeeklyReport;
