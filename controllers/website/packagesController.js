// Team N Website → Packages on Website. Chooses which CRM packages / add-ons the
// site shows and edits their website text. Name, price and advance stay owned by
// Services → Packages and cannot be changed here. Changes go live straight away.
import ServicePackage from '../../models/Package.js';
import AddonService from '../../models/AddonService.js';
import {
  ADDON_WEBSITE_FIELDS,
  PACKAGE_WEBSITE_FIELDS,
  WEBSITE_FIELD_DEFAULTS,
  validateFields,
} from '../../utils/websiteContent.js';
import { clearPublicCache } from './publicController.js';
import { deleteMediaIfUnused } from './mediaController.js';
import { imageOpts, isObjectId, validationFailed } from './shared.js';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

// Only fields present in the body are changed; a field sent as null / '' is cleared.
const buildSet = (fields, body, value) => {
  const $set = {};
  for (const key of Object.keys(fields)) {
    if (!has(body, key)) continue;
    $set[`website.${key}`] = value[key] !== undefined ? value[key] : WEBSITE_FIELD_DEFAULTS[key];
  }
  return $set;
};

// @route GET /api/website/admin/packages
export const listWebsitePackages = async (req, res) => {
  const [packages, addons] = await Promise.all([
    ServicePackage.find({}).select('name price advanceAmount description sortOrder website').sort({ sortOrder: 1, createdAt: 1 }).lean(),
    AddonService.find({}).select('name price description status website').sort({ name: 1 }).lean(),
  ]);
  res.json({
    packages: packages.map((p) => ({
      id: String(p._id),
      name: p.name,
      price: p.price,
      advanceAmount: p.advanceAmount,
      crmDescription: p.description,
      website: { ...WEBSITE_FIELD_DEFAULTS, ...(p.website ?? {}) },
    })),
    addons: addons.map((a) => ({
      id: String(a._id),
      name: a.name,
      price: a.price,
      status: a.status, // inactive add-ons never show, even if switched on here
      crmDescription: a.description,
      website: { show: false, sortOrder: null, description: '', ...(a.website ?? {}) },
    })),
  });
};

// @route PUT /api/website/admin/packages/:id   body: any of PACKAGE_WEBSITE_FIELDS
export const updatePackageWebsite = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Package not found.' });
  const r = validateFields(PACKAGE_WEBSITE_FIELDS, req.body, imageOpts());
  if (!r.ok) return validationFailed(res, r.errors);
  const $set = buildSet(PACKAGE_WEBSITE_FIELDS, req.body, r.value);
  if (!Object.keys($set).length) return res.status(400).json({ message: 'Nothing to change.' });

  const before = await ServicePackage.findById(req.params.id).select('website.coverImage').lean();
  if (!before) return res.status(404).json({ message: 'Package not found.' });

  // updateOne touches only website.* — never the CRM's name, price or region prices.
  await ServicePackage.updateOne({ _id: req.params.id }, { $set }, { runValidators: true });
  clearPublicCache();

  const oldCover = before.website?.coverImage?.publicId;
  const newCover = $set['website.coverImage']?.publicId;
  if (has(req.body, 'coverImage') && oldCover && oldCover !== newCover) await deleteMediaIfUnused(oldCover);

  const after = await ServicePackage.findById(req.params.id).select('website').lean();
  res.json({ id: req.params.id, website: { ...WEBSITE_FIELD_DEFAULTS, ...(after?.website ?? {}) } });
};

// @route PUT /api/website/admin/addons/:id   body: any of ADDON_WEBSITE_FIELDS
export const updateAddonWebsite = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Add-on not found.' });
  const r = validateFields(ADDON_WEBSITE_FIELDS, req.body);
  if (!r.ok) return validationFailed(res, r.errors);
  const $set = buildSet(ADDON_WEBSITE_FIELDS, req.body, r.value);
  if (!Object.keys($set).length) return res.status(400).json({ message: 'Nothing to change.' });

  const result = await AddonService.updateOne({ _id: req.params.id }, { $set }, { runValidators: true });
  if (!result.matchedCount) return res.status(404).json({ message: 'Add-on not found.' });
  clearPublicCache();

  const after = await AddonService.findById(req.params.id).select('website').lean();
  res.json({ id: req.params.id, website: after?.website ?? {} });
};
