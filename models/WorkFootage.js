import mongoose from 'mongoose';

// The footage of one work day of a booking: the Dropbox links the artists added (or the folder the CRM shared), the files found in the
// work's Dropbox folder, and where it stands with Marketing (new → in edit → edited). One record per booking and day.
// Rules: utils/workFootage.js. Routes: /api/work-footage (controllers/workFootageController.js).
const linkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    label: { type: String, default: '', trim: true, maxlength: 120 },
    provider: { type: String, enum: ['dropbox', 'drive'], default: 'dropbox' },
    kind: { type: String, enum: ['folder', 'file'], default: 'folder' },
    // 'artist' = pasted by someone; 'dropbox' = the folder the CRM shared after an upload through the upload page
    source: { type: String, enum: ['artist', 'dropbox'], default: 'artist' },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    addedByName: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingAsset', default: null },
    // a Dropbox FOLDER link, read through the server's Dropbox app when it was handed in (utils/dropboxFolder.js) — "12 videos · 4.2 GB"
    summary: { type: String, default: '' },
    videoCount: { type: Number, default: null },
    pictureCount: { type: Number, default: null },
    totalBytes: { type: Number, default: null },
    listedAt: { type: Date, default: null },
  },
  { _id: true },
);

const workFootageSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // the IST work day
    folderName: { type: String, default: '' },
    folderPath: { type: String, default: '' }, // in Dropbox, when the CRM made the folder
    fileRequestId: { type: String, default: '' },
    fileRequestUrl: { type: String, default: '' },
    links: { type: [linkSchema], default: [] },
    files: { type: [{ name: String, path: String, size: Number, modifiedAt: Date, _id: false }], default: [] },
    totalBytes: { type: Number, default: 0 },
    syncedAt: { type: Date, default: null },
    status: { type: String, enum: ['new', 'in_edit', 'edited'], default: 'new' },
    editorMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    editorName: { type: String, default: '' },
    taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTask', default: null },
    firstAt: { type: Date, default: null }, // when the first footage arrived
    statusAt: { type: Date, default: null },
    statusByName: { type: String, default: '' },
  },
  { timestamps: true },
);

workFootageSchema.index({ bookingId: 1, day: 1 }, { unique: true });
workFootageSchema.index({ firstAt: -1 });
workFootageSchema.index({ status: 1, firstAt: -1 });

export default mongoose.model('WorkFootage', workFootageSchema);
