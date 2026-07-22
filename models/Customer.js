import mongoose from 'mongoose';

const customerSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
      required: [true, 'Please add an email'],
      unique: true,
    },
    phone: {
      type: String,
      trim: true,
      // Phone numbers get typed with spaces and dashes ("70341 09552"), which
      // breaks equality checks and lead↔booking matching. Normalise on write.
      set: (v) => String(v ?? '').replace(/\s+/g, '').trim(),
    },
    address: {
      type: String,
      default: '',
    },
    pincode: {
      type: String,
      default: '',
    },
    company: {
      type: String,
    },
    status: {
      type: String,
      enum: ['Active', 'Inactive', 'Prospect'],
      default: 'Prospect',
    },
  },
  {
    timestamps: true,
  }
);

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
