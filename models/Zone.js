import mongoose from 'mongoose';

const zoneSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a zone name'],
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

const Zone = mongoose.model('Zone', zoneSchema);

export default Zone;
