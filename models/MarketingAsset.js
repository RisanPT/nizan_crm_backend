import mongoose from 'mongoose';

// One creative asset in the Creative Portfolio gallery — a reel, a still, a film, a carousel, a behind-the-scenes clip, a design file.
// The file itself stays where the team keeps it (a Drive / cloud link): the CRM stores the link, a thumbnail link and the facts about
// it. An asset can belong to a shoot (it then inherits the shoot's brand and tags) and, once approved, is what Socials posts from.

export const ASSET_KINDS = ['reel', 'still', 'film', 'carousel', 'bts', 'design', 'document', 'other'];
export const ASSET_MEDIA = ['video', 'image', 'design', 'document'];
// where it is in production: raw footage → in edit → post-produced → in review → approved (or rejected)
export const ASSET_STAGES = ['raw', 'in_edit', 'post_produced', 'in_review', 'approved', 'rejected'];

const marketingAssetSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    kind: { type: String, enum: ASSET_KINDS, default: 'still' },
    media: { type: String, enum: ASSET_MEDIA, default: 'image' },
    stage: { type: String, enum: ASSET_STAGES, default: 'raw' },
    url: { type: String, required: true, trim: true },
    thumbUrl: { type: String, default: '', trim: true },
    // the portfolio (a city or the company) and the page inside it (Bridal Makeup, Party Makeup…) the document's gallery filters by
    portfolio: { type: String, default: 'Main (Company)', trim: true, maxlength: 80 },
    page: { type: String, default: '', trim: true, maxlength: 80 },
    tags: { type: [String], default: [] }, // the keywords (utils/assetKeywords.js keeps one spelling each)
    durationSec: { type: Number, default: 0, min: 0 },
    sizeMb: { type: Number, default: 0, min: 0 },
    shootId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingShoot', default: null },
    isFinal: { type: Boolean, default: false }, // a final output (counts as a delivered output of its shoot)
    // when it became approved / final (set by the server; null while it is neither, and for assets approved before this was kept) —
    // the shoot's turnaround runs from the shoot date to the last of these
    approvedAt: { type: Date, default: null },
    ownerName: { type: String, default: '', trim: true }, // who is responsible for it (the person who added it, unless another is named)
    // raw footage from a work: the booking and day it came from, and its footage record (models/WorkFootage.js)
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    workDay: { type: String, default: '' },
    footageId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkFootage', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

marketingAssetSchema.index({ brand: 1, stage: 1, createdAt: -1 });
marketingAssetSchema.index({ shootId: 1 });
// the gallery's keyword filter and its newest-first pages
marketingAssetSchema.index({ tags: 1 });
marketingAssetSchema.index({ footageId: 1 });
marketingAssetSchema.index({ createdAt: -1 });

export default mongoose.model('MarketingAsset', marketingAssetSchema);
