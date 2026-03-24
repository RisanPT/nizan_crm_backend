import mongoose from 'mongoose';

const regionSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a region name'],
      trim: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

const Region = mongoose.model('Region', regionSchema);

export default Region;
