import mongoose from 'mongoose';

const fuelExpenseSchema = mongoose.Schema(
  {
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      required: [true, 'Please select a vehicle'],
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    category: {
      type: String,
      enum: ['fuel', 'food', 'toll', 'parking', 'service', 'other'],
      default: 'fuel',
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    odometerKm: {
      type: Number,
      default: 0,
      min: 0,
    },
    liters: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMode: {
      type: String,
      enum: ['cash', 'upi', 'card', 'credit', 'other'],
      default: 'cash',
    },
    station: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    // Cloudinary URL of the bill/receipt uploaded by the driver.
    billImage: {
      type: String,
      default: '',
    },
    // Fleet-manager review status.
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  }
);

const FuelExpense = mongoose.model('FuelExpense', fuelExpenseSchema);

export default FuelExpense;
