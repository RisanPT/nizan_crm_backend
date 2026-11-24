// Pure planner (no database) for seeding Team N Website content.
// Seeds are saved as DRAFTS only — staff review them, add photos and Publish.
import { isSectionKey } from '../config/websiteSections.js';
import { validateSectionData } from './websiteContent.js';

/**
 * planWebsiteSeed(seedSections, existingKeys)
 *   seedSections  { hero: {...}, faq: {...}, ... }  (from the website export)
 *   existingKeys  section keys already in the database — these are NEVER touched
 * → { create: [{ key, draft }], skip: [{ key, reason }], invalid: [{ key, errors }] }
 */
export function planWebsiteSeed(seedSections, existingKeys = []) {
  const existing = new Set(existingKeys);
  const plan = { create: [], skip: [], invalid: [] };

  for (const [key, data] of Object.entries(seedSections || {})) {
    if (!isSectionKey(key)) {
      plan.skip.push({ key, reason: 'not a website section' });
      continue;
    }
    if (existing.has(key)) {
      plan.skip.push({ key, reason: 'already set up in the CRM — left as it is' });
      continue;
    }
    const result = validateSectionData(key, data); // draft rules: required fields not enforced
    if (!result.ok) {
      plan.invalid.push({ key, errors: result.errors });
      continue;
    }
    plan.create.push({ key, draft: result.value });
  }
  return plan;
}
