import mongoose from 'mongoose';

// Every image uploaded through Team N Website, with the facts checked at upload.
// Lets the CRM list, reuse and safely delete website images (and their Cloudinary file).
const websiteMediaSchema = mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true, index: true },
    // Upload rule it passed (key of UPLOAD_RULES) and where it was uploaded from.
    rule: { type: String, required: true },
    section: { type: String, default: '' }, // section key, 'gallery' or 'package'
    field: { type: String, default: '' },
    mime: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    originalName: { type: String, default: '' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const WebsiteMedia = mongoose.model('WebsiteMedia', websiteMediaSchema);

export default WebsiteMedia;
