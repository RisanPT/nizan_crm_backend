import mongoose from 'mongoose';

export const DEPARTMENT_KEYS = ['sales', 'marketing', 'hr', 'operations', 'crm', 'it', 'inventory'];

// One month-end record per department per month. Holds only the MANUALLY-entered
// values (metrics the CRM doesn't auto-track), the planning targets/allocations,
// the action items, and notes. Auto-computed metrics are derived on read from
// live data and are NOT stored here.
const departmentReportSchema = mongoose.Schema(
  {
    department: { type: String, enum: DEPARTMENT_KEYS, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    // Manual metric values, keyed by the metric's `key` in the config.
    values: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
    // Planning targets, keyed by the target's `key`.
    targets: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
    allocations: [{ name: String, amount: Number, _id: false }],
    actionItems: [
      {
        text: String,
        owner: { type: String, default: '' },
        dueDate: { type: Date, default: null },
        done: { type: Boolean, default: false },
        _id: false,
      },
    ],
    notes: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

departmentReportSchema.index({ department: 1, year: 1, month: 1 }, { unique: true });

const DepartmentReport = mongoose.model('DepartmentReport', departmentReportSchema);

export default DepartmentReport;
