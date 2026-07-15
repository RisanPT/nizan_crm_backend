import mongoose from 'mongoose';

// A competitor brand the marketing team tracks (Instagram/FB/YT/LinkedIn etc.).
const competitorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, default: '', trim: true },
    website: { type: String, default: '', trim: true },
    category: { type: String, default: '', trim: true },
    instagram: { type: String, default: '', trim: true },
    facebook: { type: String, default: '', trim: true },
    youtube: { type: String, default: '', trim: true },
    linkedin: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '', trim: true },
    // Reserved for future multi-tenant scoping; null => studio-wide.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
  },
  { timestamps: true }
);

competitorSchema.index({ name: 1, city: 1 });

const Competitor = mongoose.model('Competitor', competitorSchema);

export default Competitor;
