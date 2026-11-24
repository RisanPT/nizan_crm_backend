// Where is a website image used? Checked before any image file is deleted,
// so a live page never ends up pointing at a missing picture.
import WebsiteSection from '../../models/WebsiteSection.js';
import WebsiteGalleryItem from '../../models/WebsiteGalleryItem.js';
import ServicePackage from '../../models/Package.js';
import { WEBSITE_SECTIONS } from '../../config/websiteSections.js';

const mentions = (value, publicId) => JSON.stringify(value ?? null).includes(`"${publicId}"`);

/** → list of human-readable places, empty when the image is unused. */
export async function findMediaUsage(publicId, { ignoreGalleryItemId = null } = {}) {
  const places = [];

  const sections = await WebsiteSection.find({}).select('key draft published').lean();
  for (const s of sections) {
    const label = WEBSITE_SECTIONS[s.key]?.label ?? s.key;
    if (mentions(s.published, publicId)) places.push(`${label} (live)`);
    else if (mentions(s.draft, publicId)) places.push(`${label} (draft)`);
  }

  const galleryFilter = { 'image.publicId': publicId };
  if (ignoreGalleryItemId) galleryFilter._id = { $ne: ignoreGalleryItemId };
  if (await WebsiteGalleryItem.exists(galleryFilter)) places.push('Portfolio gallery');

  const packages = await ServicePackage.find({ 'website.coverImage.publicId': publicId }).select('name').lean();
  for (const p of packages) places.push(`Package: ${p.name}`);

  return places;
}
