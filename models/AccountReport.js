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
      type: String, // 'pdf', 'excel', etc.
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const AccountReport = mongoose.model('AccountReport', accountReportSchema);

export default AccountReport;
