import mongoose from 'mongoose';

// HR / payroll change log (audit trail). One row per create / update / status
// change of an Employee pay record, Salary slip, payroll month lock or applied
// compensation revision. Only changed fields are stored; bank account / PAN
// values are masked to their last 4 characters before they are written.
export const AUDIT_ENTITIES = ['Employee', 'Salary', 'PayrollLock', 'CompensationRevision'];

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    from: { type: mongoose.Schema.Types.Mixed, default: null },
    to: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema({
  entity: { type: String, enum: AUDIT_ENTITIES, required: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Whose record this is (for the staff "Change history" view).
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  action: { type: String, required: true, trim: true },
  changes: { type: [changeSchema], default: [] },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byName: { type: String, default: '' },
  at: { type: Date, default: Date.now },
  note: { type: String, default: '' },
});

auditLogSchema.index({ entityId: 1, at: -1 });
auditLogSchema.index({ employeeId: 1, at: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export default AuditLog;
