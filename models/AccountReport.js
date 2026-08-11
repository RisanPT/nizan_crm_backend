import mongoose from 'mongoose';

const accountReportSchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    fileType: {
      type: String, // 'pdf', 'excel', 'csv', etc.
      required: true,
    },
    // Original filename (with extension) — used to name the download correctly.
    fileName: {
      type: String,
      default: '',
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Per-document access control. A report is visible only to its uploader,
    // any user listed here, and admins. Empty = private to the uploader (+admins).
    // The uploader manages this list; it is the whole point of the feature.
    sharedWith: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const AccountReport = mongoose.model('AccountReport', accountReportSchema);

export default AccountReport;
