import mongoose from 'mongoose';

// An AI "preview on me" image for one function of a bride's look plan.
//
// PRIVACY: this holds a picture derived from the client's face. The image bytes
// live in OUR database (not on a public image host), are only ever served to
// the owning client's login (see tryOnController.getPreviewImage), and expire
// automatically after TRYON_RETENTION_DAYS (default 30). The original selfie is
// never stored — it only passes through memory to the AI provider.

const RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.TRYON_RETENTION_DAYS, 10) || 30);

const tryOnPreviewSchema = new mongoose.Schema(
  {
    clientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientUser', required: true, index: true },
    tradition: { type: String, default: '' },
    traditionName: { type: String, default: '' },
    function: { type: String, default: '' },
    // Snapshot of what was applied, as shown to the bride.
    picks: {
      type: [{ _id: false, category: { type: String, default: '' }, name: { type: String, default: '' } }],
      default: [],
    },
    mime: { type: String, default: 'image/png' },
    bytes: { type: Number, default: 0 },
    // select:false so list queries never drag image bytes through memory.
    image: { type: Buffer, select: false, required: true },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    // True when produced by the dev "mock" provider (no AI actually applied).
    demo: { type: Boolean, default: false },
  },
  { timestamps: true },
);

tryOnPreviewSchema.index({ clientUserId: 1, createdAt: -1 });
// Auto-delete after the retention window.
tryOnPreviewSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

export const TRYON_RETENTION_DAYS = RETENTION_DAYS;

const TryOnPreview = mongoose.model('TryOnPreview', tryOnPreviewSchema);
export default TryOnPreview;
