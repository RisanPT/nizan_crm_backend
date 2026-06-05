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
