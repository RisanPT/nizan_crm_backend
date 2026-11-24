import mongoose from 'mongoose';
import { GALLERY_CATEGORIES } from '../config/websiteSections.js';

const imageSchema = mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  },
  { _id: false }
);

// One photo in the website Portfolio gallery.
const websiteGalleryItemSchema = mongoose.Schema(
  {
    image: { type: imageSchema, required: true },
    alt: { type: String, required: true, trim: true, maxlength: 150 },
    title: { type: String, default: '', trim: true, maxlength: 60 },
    description: { type: String, default: '', trim: true, maxlength: 200 },
    category: {
      type: String,
      required: true,
      enum: GALLERY_CATEGORIES.map((c) => c.key),
    },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    // Also shown in the "Recent brides" block on the home page.
    featuredOnHome: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

websiteGalleryItemSchema.index({ active: 1, category: 1, sortOrder: 1 });

const WebsiteGalleryItem = mongoose.model('WebsiteGalleryItem', websiteGalleryItemSchema);

export default WebsiteGalleryItem;
