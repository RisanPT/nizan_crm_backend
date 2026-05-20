import mongoose from 'mongoose';

const stateSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a state name'],
      trim: true,
    },
    zone: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Zone',
      required: [true, 'Please specify a zone'],
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

// Prevent duplicate state names within the same zone
stateSchema.index({ name: 1, zone: 1 }, { unique: true });

const State = mongoose.model('State', stateSchema);

export default State;
