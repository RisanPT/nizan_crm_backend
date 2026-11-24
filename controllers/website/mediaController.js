// Team N Website → image uploads and the image library.
import WebsiteMedia from '../../models/WebsiteMedia.js';
import { UPLOAD_RULES } from '../../config/websiteUploadRules.js';
import { canUseWebsite } from '../../middleware/websiteAccess.js';
import { checkImageAgainstRule } from '../../utils/imageProbe.js';
import { uploadTargetFor } from '../../utils/websiteContent.js';
import { destroyWebsiteImage, uploadWebsiteImage } from '../../utils/websiteMedia.js';
import { findMediaUsage } from './mediaUsage.js';
import { isObjectId, userId } from './shared.js';

const toClient = (m) => ({
  id: String(m._id),
  url: m.url,
  publicId: m.publicId,
  width: m.width,
  height: m.height,
  bytes: m.bytes,
  rule: m.rule,
  section: m.section,
  field: m.field,
  createdAt: m.createdAt,
});

// @route POST /api/website/admin/media/:section/:field   (multipart, field "file")
// e.g. /media/hero/imageDesktop, /media/gallery/image, /media/package/coverImage
// The file must pass that field's rule: real type, name and declared type agree,
// size, pixel size and shape. Only then is it sent to Cloudinary.
export const uploadMedia = async (req, res) => {
  const { section, field } = req.params;
  const target = uploadTargetFor(section, field);
  if (!target) return res.status(404).json({ message: 'There is no image field with that name.' });
  if (!canUseWebsite(req.user, target.area)) {
    return res.status(403).json({ message: 'You do not have access to this part of Team N Website.' });
  }

  const check = checkImageAgainstRule(req.file, UPLOAD_RULES[target.rule]);
  if (!check.ok) return res.status(check.status).json({ message: check.message, rule: target.rule });

  let stored;
  try {
    stored = await uploadWebsiteImage(req.file.buffer, target.folder);
  } catch (e) {
    console.error('Website image upload to Cloudinary failed:', e?.message || e);
    return res.status(502).json({ message: 'The image could not be stored. Please try again.' });
  }

  const media = await WebsiteMedia.create({
    url: stored.secure_url,
    publicId: stored.public_id,
    rule: target.rule,
    section,
    field,
    mime: check.mime,
    bytes: stored.bytes ?? check.bytes,
    // After Cloudinary's 2560 px cap; the pre-check used the original size.
    width: stored.width ?? check.width,
    height: stored.height ?? check.height,
    originalName: String(req.file.originalname || '').slice(0, 200),
    uploadedBy: userId(req),
  });

  // The CRM puts this object straight into the field (plus the alt text it asks for).
  res.status(201).json({
    ...toClient(media),
    value: { url: media.url, publicId: media.publicId, width: media.width, height: media.height },
  });
};

// @route GET /api/website/admin/media?rule=gallery&page=1
export const listMedia = async (req, res) => {
  const filter = {};
  if (req.query.rule) {
    if (!UPLOAD_RULES[req.query.rule]) return res.status(400).json({ message: 'Unknown upload rule.' });
    filter.rule = req.query.rule;
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 40;
  const [items, total] = await Promise.all([
    WebsiteMedia.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    WebsiteMedia.countDocuments(filter),
  ]);
  res.json({ items: items.map(toClient), page, total, pages: Math.ceil(total / limit) });
};

// @route DELETE /api/website/admin/media/:id
// Refused (409) while the image is used anywhere, live or draft.
export const deleteMedia = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Image not found.' });
  const media = await WebsiteMedia.findById(req.params.id).lean();
  if (!media) return res.status(404).json({ message: 'Image not found.' });

  const usedIn = await findMediaUsage(media.publicId);
  if (usedIn.length) {
    return res.status(409).json({ message: `This image is still used in: ${usedIn.join(', ')}.`, usedIn });
  }

  try {
    await destroyWebsiteImage(media.publicId);
  } catch (e) {
    console.error('Website image delete on Cloudinary failed:', e?.message || e);
    return res.status(502).json({ message: 'The image could not be removed. Please try again.' });
  }
  await WebsiteMedia.deleteOne({ _id: media._id });
  res.json({ message: 'Image deleted.' });
};

// Used by the gallery: remove an image file once nothing uses it any more.
export async function deleteMediaIfUnused(publicId) {
  if (!publicId) return false;
  const usedIn = await findMediaUsage(publicId);
  if (usedIn.length) return false;
  try {
    await destroyWebsiteImage(publicId);
  } catch (e) {
    console.error('Website image delete on Cloudinary failed:', e?.message || e);
    return false;
  }
  await WebsiteMedia.deleteOne({ publicId });
  return true;
}
