// Draft preview: staff get a short-lived link that shows the website with
// unpublished drafts, without publishing anything.
import jwt from 'jsonwebtoken';
import WebsiteSection from '../../models/WebsiteSection.js';
import { SECTION_KEYS } from '../../config/websiteSections.js';
import { previewSections } from '../../utils/websitePreview.js';
import { userId } from './shared.js';

const PREVIEW_TYP = 'website-preview';
const PREVIEW_TTL_SEC = 60 * 60; // 1 hour

// @route POST /api/website/admin/preview-token   (staff)
// → { token, expiresAt }. The token carries no user id, so it can never be
// used as a CRM login (protect() looks the user up by id).
export const issuePreviewToken = async (req, res) => {
  const token = jwt.sign({ typ: PREVIEW_TYP, by: String(userId(req) ?? '') }, process.env.JWT_SECRET, {
    expiresIn: PREVIEW_TTL_SEC,
  });
  res.json({ token, expiresAt: new Date(Date.now() + PREVIEW_TTL_SEC * 1000).toISOString() });
};

// @route GET /api/website/public/preview?token=…   (no login, token required)
// Same shape as /content, but each section shows its draft when it has one.
export const getPreviewContent = async (req, res) => {
  try {
    const decoded = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET);
    if (decoded.typ !== PREVIEW_TYP) throw new Error('wrong token type');
  } catch {
    return res.status(401).json({ message: 'This preview link has expired. Open a new one from the CRM.' });
  }
  const rows = await WebsiteSection.find({ key: { $in: SECTION_KEYS } }).select('key draft published').lean();
  res.set('Cache-Control', 'no-store');
  res.json({ sections: previewSections(rows), preview: true });
};
