import mongoose from 'mongoose';

// A company report document (PDF/Excel/CSV/…) uploaded to the ERP and filed
// under a DEPARTMENT. Access is by department + role: admins/managers see all,
// the uploader always sees their own, members of the report's department see it,
// plus any roles/users it is explicitly shared with.
const companyReportSchema = mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    // The department this report is filed under (name, e.g. "Sales", "HR").
    department: { type: String, required: true, trim: true },
    // Optional folder (within the department) this report is categorised under.
    // null = "Unfiled" (department root).
    folder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReportFolder',
      default: null,
    },
    // Optional reporting period label, e.g. "Aug 2026" or "Q1 FY26".
    period: { type: String, default: '' },

    fileUrl: { type: String, required: true },
    fileType: { type: String, required: true }, // pdf | excel | csv | other
    fileName: { type: String, default: '' },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The uploader's OWN department at upload time (denormalized) — lets a
    // department head see everything their team uploaded, regardless of which
    // department the report was filed under.
    uploaderDepartment: { type: String, default: '' },

    // Extra role keys granted view access beyond the department's own members
    // (e.g. give "accounts" visibility into every department's reports).
    visibleToRoles: { type: [String], default: [] },
    // Extra individual users granted access.
    sharedWith: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: true },
);

companyReportSchema.index({ department: 1, createdAt: -1 });

const CompanyReport = mongoose.model('CompanyReport', companyReportSchema);

export default CompanyReport;
