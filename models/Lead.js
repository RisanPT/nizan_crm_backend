import mongoose from 'mongoose';

const leadSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
    },
    phone: {
      type: String,
      required: [true, 'Please add a phone number'],
    },
    source: {
      type: String,
      default: 'Walk-in',
    },
    location: {
      type: String,
      default: '',
    },
    leadType: {
      type: String,
      default: 'Individual',
    },
    // Manually set date when the lead was actually received (can be past)
    leadDate: {
      type: Date,
      // No default — so existing docs without this field return null,
      // and Flutter correctly falls back to createdAt.
    },
    enquiryDate: {
      type: Date,
      default: Date.now,
    },
    bookedDate: {
      type: Date,
      default: null,
    },
    // Date + time for follow-up reminder (only when status is Follow-up)
    followUpDate: {
      type: Date,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['New', 'Contacted', 'Qualified', 'Lost', 'Converted', 'Follow-up'],
      default: 'New',
    },
    reason: {
      type: String,
      default: '',
    },
    remarks: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
