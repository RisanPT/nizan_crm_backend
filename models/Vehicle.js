import mongoose from 'mongoose';
import { CATEGORY_KEYS } from '../utils/vehicleCategories.js';

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
    // Finer class than `type`: sedan / xl / mpv … ('' = not set yet). See
    // utils/vehicleCategories.js for the list and the default seat counts.
    category: {
      type: String,
      enum: ['', ...CATEGORY_KEYS],
      default: '',
    },
    // Passengers it takes besides the driver (0 = not recorded).
    seats: {
      type: Number,
      default: 0,
      min: 0,
      max: 60,
    },
    // Fuel efficiency information. `ratedMileage` is the manufacturer / expected
    // figure: km per litre for petrol & diesel, km per kg for CNG, km per kWh for
    // electric (0 = not recorded). The ACTUAL figure is worked out from fill-ups
    // — see utils/fuelEfficiency.js.
    ratedMileage: {
      type: Number,
      default: 0,
      min: 0,
      max: 500,
    },
    // Litres (or kg / kWh for CNG / electric) the tank takes when full.
    tankCapacity: {
      type: Number,
      default: 0,
      min: 0,
      max: 1000,
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
      enum: ['running', 'under_service', 'accident', 'complaint', 'other'],
      default: 'running',
    },
    // Latest odometer reading (km), updated from each completed trip's endKm.
    // Service reminders compare their dueKm against this.
    currentKm: {
      type: Number,
      default: 0,
      min: 0,
    },
    parkedLocation: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    ownershipType: {
      type: String,
      enum: ['in_house', 'rented'],
      default: 'in_house',
    },
  },
  {
    timestamps: true,
  }
);

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

export default Vehicle;
