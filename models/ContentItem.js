import mongoose from 'mongoose';

// A single planned piece of social/marketing content — one card on the content
// planning calendar. Belongs to the Marketing module.

// Every platform the Socials screens offer. The list only ever grows, so posts saved earlier stay valid.
export const CONTENT_PLATFORMS = ['instagram', 'youtube', 'facebook', 'whatsapp', 'website', 'pinterest', 'snapchat', 'linkedin', 'tiktok', 'other'];

const contentItemSchema = mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    platform: {
      type: String,
      enum: CONTENT_PLATFORMS,
      default: 'instagram',
    },
    contentType: {
      type: String,
      enum: ['reel', 'trial_reel', 'post', 'story', 'carousel', 'collab', 'video', 'image', 'blog', 'other'],
      default: 'reel',
    },
    // The publishing pipeline the Socials screens count by: idea/planned → Planned, in-progress → Producing, in-review → In Review,
    // scheduled → Scheduled, published → Published.
    status: {
      type: String,
      enum: ['idea', 'planned', 'in-progress', 'in-review', 'scheduled', 'published', 'cancelled'],
      default: 'idea',
    },
    // Which brand's account it goes out on (the document's Main / Kerala split).
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    // The calendar date this content is planned/scheduled for.
    scheduledDate: { type: Date, required: true },
    publishedDate: { type: Date, default: null },

    // Owner — refs Employee (like the rest of the app's assignment pickers).
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    assignedToName: { type: String, default: '' },

    campaign: { type: String, default: '' },
    caption: { type: String, default: '' },
    hashtags: { type: [String], default: [] },
    mediaUrls: { type: [String], default: [] },
    notes: { type: String, default: '' },

    // After it is out (typed from the platform's insights, or brought in by the Instagram sync — services/metaIgSync.js): drives
    // Performance, Top Performing Content and the engagement overview.
    permalink: { type: String, default: '', trim: true },
    thumbUrl: { type: String, default: '', trim: true },
    metrics: {
      reach: { type: Number, default: 0, min: 0 },
      impressions: { type: Number, default: 0, min: 0 },
      views: { type: Number, default: 0, min: 0 },
      likes: { type: Number, default: 0, min: 0 },
      comments: { type: Number, default: 0, min: 0 },
      reposts: { type: Number, default: 0, min: 0 },
      shares: { type: Number, default: 0, min: 0 },
      saves: { type: Number, default: 0, min: 0 },
      linkClicks: { type: Number, default: 0, min: 0 },
    },
    // the Instagram post it is (set by the Instagram sync when it links them); its figures then come from Instagram ('instagram'), each
    // sync replacing reach, views, likes, comments, shares and saves (impressions, reposts and link clicks stay as typed)
    igMediaId: { type: String, default: '', trim: true },
    metricsSource: { type: String, enum: ['', 'manual', 'instagram'], default: '' },
    metricsSyncedAt: { type: Date, default: null },
    // an approved asset from the Creative Portfolio gallery this post uses
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingAsset', default: null },
    // the shoot the post comes from: the asset's shoot when it uses one (set by the server), else the shoot it was planned for. A
    // published post linked to a shoot counts as one of that shoot's delivered outputs (utils/marketingPortfolioStats.js).
    shootId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingShoot', default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

contentItemSchema.index({ scheduledDate: 1 });
contentItemSchema.index({ brand: 1, status: 1, scheduledDate: 1 });
contentItemSchema.index({ shootId: 1 });
contentItemSchema.index({ assetId: 1 });
contentItemSchema.index({ igMediaId: 1 }, { unique: true, partialFilterExpression: { igMediaId: { $type: 'string', $gt: '' } } });

export default mongoose.model('ContentItem', contentItemSchema);
