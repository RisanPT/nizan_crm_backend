import mongoose from 'mongoose';

const districtSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a district name'],
      trim: true,
    },
    region: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      required: [true, 'Please specify a region'],
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

// Prevent duplicate district names within the same region
districtSchema.index({ name: 1, region: 1 }, { unique: true });

const District = mongoose.model('District', districtSchema);

export default District;
