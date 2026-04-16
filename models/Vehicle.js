import mongoose from 'mongoose';

const vehicleSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a vehicle name'],
      trim: true,
    },
    registrationNumber: {
      type: String,
      required: [true, 'Please add a registration number'],
      trim: true,
      unique: true,
    },
    type: {
      type: String,
      enum: ['car', 'van', 'bike', 'other'],
      default: 'car',
    },
    brand: {
      type: String,
      default: '',
      trim: true,
    },
    fuelType: {
      type: String,
      enum: ['petrol', 'diesel', 'electric', 'hybrid', 'cng', 'other'],
      default: 'petrol',
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'maintenance', 'inactive'],
      default: 'active',
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

export default Vehicle;
