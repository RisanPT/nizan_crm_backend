import mongoose from 'mongoose';

const regionPriceSchema = mongoose.Schema(
  {
    region: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const packageSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a package name'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Please add a base price'],
      min: 0,
    },
    advanceAmount: {
      type: Number,
      default: 3000,
      min: 0,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    regionPrices: {
      type: [regionPriceSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const ServicePackage = mongoose.model('Package', packageSchema);

export default ServicePackage;
