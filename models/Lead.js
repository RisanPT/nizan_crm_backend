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
    // Set automatically when a booking is created for this lead's phone
    // number, so a converted lead links straight to the work it produced.
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    // Geography copied from the booking on conversion, so lead reporting can
    // be sliced by district / region / pincode using confirmed address data.
    address: { type: String, default: '' },
    pincode: { type: String, default: '' },
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      default: null,
    },
    region: { type: String, default: '' },
    district: { type: String, default: '' },
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
