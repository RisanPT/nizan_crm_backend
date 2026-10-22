import mongoose from 'mongoose';

const slotHoldSchema = mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },
    dateStr: {
      type: String,
      required: true,
      index: true, // 'YYYY-MM-DD'
    },
    slot: {
      type: String,
      required: true,
      enum: ['Morning', 'Afternoon', 'Evening', 'Full day', 'morning', 'afternoon', 'evening', 'fullday'],
      default: 'Morning',
    },
    clientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClientUser',
      required: true,
      index: true,
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package',
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: '0s' }, // MongoDB TTL index automatically cleans up expired holds
    },
    status: {
      type: String,
      enum: ['active', 'converted', 'released'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to quickly query active holds for a specific date & slot
slotHoldSchema.index({ dateStr: 1, slot: 1, status: 1 });

const SlotHold = mongoose.model('SlotHold', slotHoldSchema);

export default SlotHold;
