import mongoose from 'mongoose';

// A social account the team publishes on (Instagram — Main, Instagram — Kerala, YouTube…). The status is honest: 'manual' = posts
// and figures are typed in; 'connected' = the Instagram sync reads it (services/metaIgSync.js, igUserId = Instagram's id). Followers
// are typed from the platform, or synced, and kept as a dated history so growth can be shown.
export const ACCOUNT_STATUSES = ['manual', 'connected', 'disconnected'];

const socialAccountSchema = new mongoose.Schema(
  {
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    platform: { type: String, required: true, trim: true, lowercase: true },
    handle: { type: String, default: '', trim: true, maxlength: 120 },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'manual' },
    followers: { type: Number, default: 0, min: 0 },
    history: { type: [{ day: String, followers: Number, _id: false }], default: [] },
    note: { type: String, default: '', trim: true, maxlength: 300 },
    igUserId: { type: String, default: '', trim: true },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

socialAccountSchema.index({ brand: 1, platform: 1, handle: 1 }, { unique: true });

export default mongoose.model('SocialAccount', socialAccountSchema);
