import mongoose from 'mongoose';

// A competitor brand the marketing team tracks (Instagram/FB/YT/LinkedIn etc.).
const competitorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    city: { type: String, default: '', trim: true },
    // Link to our own geographics so competitor data can be sliced by region,
    // the same way bookings/leads are. `region` is the denormalized name (so
    // list queries stay populate-free) and `regionId` the canonical reference.
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
    region: { type: String, default: '', trim: true },
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
competitorSchema.index({ regionId: 1 });

const Competitor = mongoose.model('Competitor', competitorSchema);

export default Competitor;
