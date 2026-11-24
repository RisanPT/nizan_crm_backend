// Team N Website (CRM menu) — staff-only API for managing the public website.
// Every route needs a login and the 'website' permission (or its sub-key).
import express from 'express';
import { attachRolePermissions, protect } from '../middleware/authMiddleware.js';
import { requireWebsite } from '../middleware/websiteAccess.js';
import { websiteUpload } from '../middleware/websiteUpload.js';
import {
  getSchema,
  getSection,
  listSections,
  publishSection,
  revertSection,
  saveDraft,
} from '../controllers/website/sectionController.js';
import {
  createGalleryItem,
  deleteGalleryItem,
  listGallery,
  reorderGallery,
  updateGalleryItem,
} from '../controllers/website/galleryController.js';
import { deleteMedia, listMedia, uploadMedia } from '../controllers/website/mediaController.js';
import {
  listWebsitePackages,
  updateAddonWebsite,
  updatePackageWebsite,
} from '../controllers/website/packagesController.js';
import { listEnquiries, updateEnquiry } from '../controllers/website/enquiryController.js';
import { issuePreviewToken } from '../controllers/website/previewController.js';
import { getVisitorStats } from '../controllers/website/visitController.js';

const router = express.Router();

router.use(protect, attachRolePermissions, requireWebsite());

const content = requireWebsite('content');
const gallery = requireWebsite('gallery');
const packages = requireWebsite('packages');
const enquiries = requireWebsite('enquiries');

router.get('/schema', getSchema);
// Visitor counts: anyone with Team N Website access (Overview dashboard).
router.get('/visitors', getVisitorStats);

router.get('/sections', content, listSections);
router.get('/sections/:key', content, getSection);
router.put('/sections/:key', content, saveDraft);
router.post('/sections/:key/publish', content, publishSection);
router.post('/sections/:key/revert', content, revertSection);
router.post('/preview-token', content, issuePreviewToken);

router.get('/gallery', gallery, listGallery);
router.post('/gallery', gallery, createGalleryItem);
router.put('/gallery/reorder', gallery, reorderGallery); // before '/:id'
router.put('/gallery/:id', gallery, updateGalleryItem);
router.delete('/gallery/:id', gallery, deleteGalleryItem);

router.get('/packages', packages, listWebsitePackages);
router.put('/packages/:id', packages, updatePackageWebsite);
router.put('/addons/:id', packages, updateAddonWebsite);

router.get('/enquiries', enquiries, listEnquiries);
router.patch('/enquiries/:id', enquiries, updateEnquiry);

// Area access for uploads is checked in the controller (depends on the target field).
router.post('/media/:section/:field', websiteUpload, uploadMedia);
router.get('/media', listMedia);
router.delete('/media/:id', deleteMedia);

export default router;
