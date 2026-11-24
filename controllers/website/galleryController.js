// Team N Website → Portfolio gallery (also feeds "Recent brides" on the home page).
// Gallery changes go live straight away (no draft step).
import WebsiteGalleryItem from '../../models/WebsiteGalleryItem.js';
import { GALLERY_CATEGORIES } from '../../config/websiteSections.js';
import { validateFields } from '../../utils/websiteContent.js';
import { deleteMediaIfUnused } from './mediaController.js';
import { imageOpts, isObjectId, userId, validationFailed } from './shared.js';

const GALLERY_FIELDS = {
  image: { type: 'image', label: 'Photo', rule: 'gallery', required: true },
  category: { type: 'text', label: 'Category', maxLength: 20, required: true },
  title: { type: 'text', label: 'Title', maxLength: 60 },
  description: { type: 'textarea', label: 'Description', maxLength: 200 },
  active: { type: 'boolean', label: 'Show on website' },
  featuredOnHome: { type: 'boolean', label: 'Show in Recent brides' },
};
const MAX_ITEMS = 300;

// The CRM sends alt text inside the image object (same as section images).
const validateItem = (body, { forPublish }) => {
  const r = validateFields(GALLERY_FIELDS, body, { ...imageOpts(), forPublish });
  if (r.value.category && !GALLERY_CATEGORIES.some((c) => c.key === r.value.category)) {
    r.errors.push('category must be one of: ' + GALLERY_CATEGORIES.map((c) => c.key).join(', '));
    r.ok = false;
  }
  return r;
};

const toDoc = (v) => {
  const doc = {};
  if (v.image) {
    doc.image = { url: v.image.url, publicId: v.image.publicId, width: v.image.width, height: v.image.height };
    doc.alt = v.image.alt;
  }
  for (const k of ['category', 'title', 'description', 'active', 'featuredOnHome']) {
    if (v[k] !== undefined) doc[k] = v[k];
  }
  return doc;
};

const toClient = (g) => ({
  id: String(g._id),
  image: { ...g.image, alt: g.alt },
  category: g.category,
  title: g.title,
  description: g.description,
  active: g.active,
  featuredOnHome: g.featuredOnHome,
  sortOrder: g.sortOrder,
  updatedAt: g.updatedAt,
});

// @route GET /api/website/admin/gallery
export const listGallery = async (req, res) => {
  const items = await WebsiteGalleryItem.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ categories: GALLERY_CATEGORIES, items: items.map(toClient) });
};

// @route POST /api/website/admin/gallery
// body: { image: { url, publicId, width, height, alt }, category, title?, description?, active?, featuredOnHome? }
export const createGalleryItem = async (req, res) => {
  const r = validateItem(req.body, { forPublish: true });
  if (!r.ok) return validationFailed(res, r.errors);
  if ((await WebsiteGalleryItem.countDocuments({})) >= MAX_ITEMS) {
    return res.status(400).json({ message: `The gallery can hold up to ${MAX_ITEMS} photos. Remove some first.` });
  }
  const last = await WebsiteGalleryItem.findOne({}).sort({ sortOrder: -1 }).select('sortOrder').lean();
  const item = await WebsiteGalleryItem.create({
    ...toDoc(r.value),
    sortOrder: (last?.sortOrder ?? -1) + 1,
    createdBy: userId(req),
  });
  res.status(201).json(toClient(item.toObject()));
};

// @route PUT /api/website/admin/gallery/:id   (only the fields sent are changed)
export const updateGalleryItem = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Photo not found.' });
  const item = await WebsiteGalleryItem.findById(req.params.id);
  if (!item) return res.status(404).json({ message: 'Photo not found.' });

  const r = validateItem(req.body, { forPublish: false });
  if (!r.ok) return validationFailed(res, r.errors);
  const oldPublicId = item.image?.publicId;
  item.set(toDoc(r.value));
  await item.save();

  // A replaced photo's old file is removed if nothing else uses it.
  if (oldPublicId && oldPublicId !== item.image?.publicId) await deleteMediaIfUnused(oldPublicId);
  res.json(toClient(item.toObject()));
};

// @route PUT /api/website/admin/gallery/reorder   body: { ids: [...] } in display order
export const reorderGallery = async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length || ids.length > MAX_ITEMS || !ids.every(isObjectId) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ message: 'Send the photo ids in their new order.' });
  }
  await WebsiteGalleryItem.bulkWrite(
    ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: i } } } })),
  );
  res.json({ message: 'Order saved.' });
};

// @route DELETE /api/website/admin/gallery/:id
export const deleteGalleryItem = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Photo not found.' });
  const item = await WebsiteGalleryItem.findByIdAndDelete(req.params.id).lean();
  if (!item) return res.status(404).json({ message: 'Photo not found.' });
  await deleteMediaIfUnused(item.image?.publicId);
  res.json({ message: 'Photo removed.' });
};
