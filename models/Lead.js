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
      default: 'Website',
    },
    status: {
      type: String,
      enum: ['New', 'Contacted', 'Qualified', 'Lost', 'Converted'],
      default: 'New',
    },
  },
  {
    timestamps: true,
  }
);

const Lead = mongoose.model('Lead', leadSchema);

export default Lead;
