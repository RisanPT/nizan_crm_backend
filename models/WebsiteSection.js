import mongoose from 'mongoose';

// One document per editable website section (keys from config/websiteSections.js).
// Staff edit `draft`; Publish copies it to `published`, which is all the public site sees.
const websiteSectionSchema = mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    draft: { type: mongoose.Schema.Types.Mixed, default: {} },
    published: { type: mongoose.Schema.Types.Mixed, default: null },
    // draft     = never published
    // published = draft and published are the same
    // changed   = published, but the draft has unpublished edits
    status: { type: String, enum: ['draft', 'published', 'changed'], default: 'draft' },
    draftUpdatedAt: { type: Date, default: null },
    draftUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false }
);

const WebsiteSection = mongoose.model('WebsiteSection', websiteSectionSchema);

export default WebsiteSection;
