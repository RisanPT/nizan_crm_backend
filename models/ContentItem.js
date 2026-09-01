import mongoose from 'mongoose';

// A single planned piece of social/marketing content — one card on the content
// planning calendar. Belongs to the Marketing module.
const contentItemSchema = mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    platform: {
      type: String,
      enum: ['instagram', 'youtube', 'facebook', 'whatsapp', 'website', 'other'],
      default: 'instagram',
    },
    contentType: {
      type: String,
      enum: ['reel', 'post', 'story', 'carousel', 'video', 'blog', 'other'],
      default: 'reel',
    },
    status: {
      type: String,
      enum: ['idea', 'planned', 'in-progress', 'scheduled', 'published', 'cancelled'],
      default: 'idea',
    },
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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

contentItemSchema.index({ scheduledDate: 1 });

export default mongoose.model('ContentItem', contentItemSchema);
