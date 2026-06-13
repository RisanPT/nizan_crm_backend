import mongoose from 'mongoose';

const leadActivitySchema = mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['followup', 'call', 'activity'],
      required: true,
    },
    scheduledDate: {
      type: Date,
      required: true,
    },
    remark: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['Pending', 'Completed', 'Cancelled'],
      default: 'Pending',
    },
    callResponse: {
      type: String,
      enum: ['Connected', 'No Answer', 'Busy', 'Switched Off', 'N/A'],
      default: 'N/A',
    },
    attachments: [
      {
        type: String, // Cloudinary URLs
      },
    ],
  },
  {
    timestamps: true,
  }
);

const LeadActivity = mongoose.model('LeadActivity', leadActivitySchema);
export default LeadActivity;
