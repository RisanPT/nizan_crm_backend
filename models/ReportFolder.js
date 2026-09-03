import mongoose from 'mongoose';

// A folder to categorise company-report documents WITHIN a department. Each
// department owns its own folders; documents reference a folder (or none =
// "Unfiled"). Created by department members; admins/managers can manage any.
const reportFolderSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a folder name'],
      trim: true,
    },
    // The department this folder belongs to (name, e.g. "Sales", "HR").
    department: {
      type: String,
      required: [true, 'A folder must belong to a department'],
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

// One folder name per department.
reportFolderSchema.index({ department: 1, name: 1 }, { unique: true });

const ReportFolder = mongoose.model('ReportFolder', reportFolderSchema);

export default ReportFolder;
