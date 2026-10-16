import mongoose from 'mongoose';

// A job title / designation (e.g. "Senior Makeup Artist", "Accounts Executive").
// Optional `departmentId` narrows it to one department; `level` orders the grade
// (1 = junior-most) for org-chart / grade reporting. FK target for Employee.designationId.
const designationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: '' },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    level: { type: Number, default: 1 },
    description: { type: String, trim: true, default: '' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

designationSchema.index({ departmentId: 1, order: 1 });

const Designation = mongoose.model('Designation', designationSchema);

export default Designation;
