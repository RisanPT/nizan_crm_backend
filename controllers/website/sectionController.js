// Team N Website → page sections. Staff edit a draft; Publish makes it live.
// Mounted at /api/website/admin (protect + 'website' permission).
import WebsiteSection from '../../models/WebsiteSection.js';
import {
  GALLERY_CATEGORIES,
  SECTION_KEYS,
  WEBSITE_SECTIONS,
  isSectionKey,
} from '../../config/websiteSections.js';
import { publicRule } from '../../config/websiteUploadRules.js';
import {
  ADDON_WEBSITE_FIELDS,
  PACKAGE_WEBSITE_FIELDS,
  validateSectionData,
} from '../../utils/websiteContent.js';
import { sectionDefaults } from '../../utils/websiteDefaults.js';
import { clearPublicCache } from './publicController.js';
import { imageOpts, userId, validationFailed } from './shared.js';

// Adds the full upload rule to every image field so the CRM can show hints and pre-check files.
const describeFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, def]) => {
      const out = { ...def };
      if (def.type === 'image') out.upload = publicRule(def.rule);
      if (def.type === 'list') out.fields = describeFields(def.fields);
      return [name, out];
    }),
  );

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const summary = (key, doc) => ({
  key,
  label: WEBSITE_SECTIONS[key].label,
  page: WEBSITE_SECTIONS[key].page,
  status: doc?.status ?? 'empty',
  draftUpdatedAt: doc?.draftUpdatedAt ?? null,
  publishedAt: doc?.publishedAt ?? null,
});

const unknownSection = (res) => res.status(404).json({ message: 'Unknown website section.' });

// @route GET /api/website/admin/schema
export const getSchema = async (req, res) => {
  res.json({
    sections: Object.fromEntries(
      SECTION_KEYS.map((k) => [
        k,
        { label: WEBSITE_SECTIONS[k].label, page: WEBSITE_SECTIONS[k].page, fields: describeFields(WEBSITE_SECTIONS[k].fields) },
      ]),
    ),
    gallery: { categories: GALLERY_CATEGORIES, upload: publicRule('gallery') },
    packageFields: describeFields(PACKAGE_WEBSITE_FIELDS),
    addonFields: describeFields(ADDON_WEBSITE_FIELDS),
  });
};

// @route GET /api/website/admin/sections
export const listSections = async (req, res) => {
  const docs = await WebsiteSection.find({ key: { $in: SECTION_KEYS } })
    .select('key status draftUpdatedAt publishedAt')
    .lean();
  const byKey = new Map(docs.map((d) => [d.key, d]));
  res.json({ sections: SECTION_KEYS.map((k) => summary(k, byKey.get(k))) });
};

// @route GET /api/website/admin/sections/:key
export const getSection = async (req, res) => {
  const { key } = req.params;
  if (!isSectionKey(key)) return unknownSection(res);
  const doc = await WebsiteSection.findOne({ key })
    .populate('draftUpdatedBy', 'name')
    .populate('publishedBy', 'name')
    .lean();
  res.json({
    ...summary(key, doc),
    draft: doc?.draft ?? {},
    published: doc?.published ?? null,
    draftUpdatedBy: doc?.draftUpdatedBy?.name ?? null,
    publishedBy: doc?.publishedBy?.name ?? null,
    // The website's built-in text: the editor starts from it when nothing is saved yet.
    defaults: sectionDefaults(key),
  });
};

// @route PUT /api/website/admin/sections/:key   body: the section's fields
// Saves a draft. Drafts may be incomplete; formats and lengths are still checked.
export const saveDraft = async (req, res) => {
  const { key } = req.params;
  if (!isSectionKey(key)) return unknownSection(res);
  const result = validateSectionData(key, req.body, imageOpts());
  if (!result.ok) return validationFailed(res, result.errors);

  const doc = (await WebsiteSection.findOne({ key })) ?? new WebsiteSection({ key });
  doc.draft = result.value;
  doc.markModified('draft');
  doc.draftUpdatedAt = new Date();
  doc.draftUpdatedBy = userId(req);
  doc.status = doc.published == null ? 'draft' : sameJson(doc.published, result.value) ? 'published' : 'changed';
  await doc.save();
  res.json({ ...summary(key, doc), draft: doc.draft });
};

// @route POST /api/website/admin/sections/:key/publish
// Copies the saved draft to the live site. Empty fields keep the website's built-in
// content; list items must be complete (e.g. an FAQ question needs its answer).
export const publishSection = async (req, res) => {
  const { key } = req.params;
  if (!isSectionKey(key)) return unknownSection(res);
  const doc = await WebsiteSection.findOne({ key });
  if (!doc) return res.status(400).json({ message: 'Save a draft of this section before publishing.' });

  const result = validateSectionData(key, doc.draft, { ...imageOpts(), forPublish: true });
  if (!result.ok) return validationFailed(res, result.errors);

  doc.draft = result.value;
  doc.published = result.value;
  doc.markModified('draft');
  doc.markModified('published');
  doc.status = 'published';
  doc.publishedAt = new Date();
  doc.publishedBy = userId(req);
  await doc.save();
  clearPublicCache();
  res.json({ ...summary(key, doc), published: doc.published });
};

// @route POST /api/website/admin/sections/:key/revert
// Throws away unpublished edits: the draft goes back to what is live.
export const revertSection = async (req, res) => {
  const { key } = req.params;
  if (!isSectionKey(key)) return unknownSection(res);
  const doc = await WebsiteSection.findOne({ key });
  if (!doc || doc.published == null) {
    return res.status(400).json({ message: 'This section has never been published, so there is nothing to go back to.' });
  }
  doc.draft = doc.published;
  doc.markModified('draft');
  doc.status = 'published';
  doc.draftUpdatedAt = new Date();
  doc.draftUpdatedBy = userId(req);
  await doc.save();
  res.json({ ...summary(key, doc), draft: doc.draft });
};
