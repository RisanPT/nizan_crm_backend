import mongoose from 'mongoose';

const addonServiceSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add an add-on service name'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Please add an add-on service price'],
      min: 0,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Public website. Hidden until switched on in Team N Website.
    website: {
      show: { type: Boolean, default: false },
      sortOrder: { type: Number, default: null },
      description: { type: String, default: '', trim: true, maxlength: 200 },
    },
  },
  {
    timestamps: true,
  }
);

const AddonService = mongoose.model('AddonService', addonServiceSchema);

export default AddonService;
