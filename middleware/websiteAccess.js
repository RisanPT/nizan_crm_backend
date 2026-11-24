// Access to Team N Website (the public-site CMS). Mount AFTER protect and
// attachRolePermissions.
//
//   'website'            → everything in the menu
//   'website.content'    → page sections + SEO + contact
//   'website.gallery'    → portfolio gallery
//   'website.packages'   → which packages/add-ons show, and their website text
//   'website.enquiries'  → enquiries from the site (P5)
// The admin role always has access, even if its Role record is out of date.

export const WEBSITE_AREAS = ['content', 'gallery', 'packages', 'enquiries'];

export const canUseWebsite = (user, area) => {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('website')) return true;
  if (!area) return perms.some((p) => p.startsWith('website.'));
  return perms.includes(`website.${area}`);
};

export const requireWebsite = (area) => (req, res, next) => {
  if (canUseWebsite(req.user, area)) return next();
  return res.status(403).json({ message: 'You do not have access to this part of Team N Website.' });
};
