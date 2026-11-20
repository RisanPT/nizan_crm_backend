import { istDay } from './marketingTeamStats.js';

// ONE definition of how the Marketing screens read a CRM Lead (models/Lead.js) — used by Socials, Lead Report, Campaigns and the
// Weekly Report so the same lead is the same thing everywhere. Pure (tests/marketingLeadStages.test.js).
//
//  • STAGE — the CRM's status, grouped the way the marketing document's Lead Stages shows it:
//      New → New · Contacted / Qualified / Follow-up / Pending Lost Approval → In Progress · Lost → Not Converted · Converted → Converted.
//    (A lead waiting for its "lost" to be approved is still open, so it stays In Progress.)
//  • QUALIFIED — the lead reached Qualified or beyond: Qualified, Follow-up or Converted (the funnel's "Qualified" step).
//  • QUALITY — the CRM's own priority: Hot, Warm, Nurture (interested, a long way off — keep in touch), Cold. A lead with no priority
//    (made before the field existed, or cleared) is "Not rated" — never guessed as Warm.
//  • DAY — the day the enquiry arrived: the lead's leadDate, else the day it was created (IST).
//  • SOURCE — the CRM's canonical sources (sales_leads_screen.dart `kLeadSources`) as a key and a label; Paid Ads and Trial Campaign
//    leads both come from the Meta ad campaigns. The two Instagram pages are the two brands (Main / Kerala). "Website" = the site's forms.
//  • BRAND — a lead tagged to a campaign belongs to the campaign's brand (the ad account it came through: `campaignBrand`, written on the
//    lead by utils/marketingOutcomes.js withCampaignBrand when it is loaded); otherwise an Instagram page names its brand; otherwise the
//    lead's region / district decides (Kerala regions → Kerala, else Main).

export const LEAD_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'not_converted', label: 'Not Converted' },
  { key: 'converted', label: 'Converted' },
];

const STAGE_OF = { New: 'new', Contacted: 'in_progress', Qualified: 'in_progress', 'Follow-up': 'in_progress', 'Pending Lost Approval': 'in_progress', Lost: 'not_converted', Converted: 'converted' };
export const stageOfLead = (status) => STAGE_OF[status] ?? 'new';
export const isQualified = (status) => ['Qualified', 'Follow-up', 'Converted'].includes(status);
export const isOpen = (status) => !['Lost', 'Converted'].includes(status);

export const QUALITIES = ['Hot', 'Warm', 'Nurture', 'Cold'];
/** The bucket of a lead with no (or an unknown) priority. Shown only when some lead is in it. */
export const NOT_RATED = 'Not rated';
export const qualityOf = (lead) => {
  const p = String(lead?.priority ?? '').trim().toLowerCase();
  return QUALITIES.find((q) => q.toLowerCase() === p) ?? NOT_RATED;
};

export const leadDay = (lead) => istDay(lead.leadDate ?? lead.createdAt);

export const SOURCES = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ig_main', label: 'Instagram (Main)' },
  { key: 'ig_kerala', label: 'Instagram (Kerala)' },
  { key: 'meta_ads', label: 'Meta Ads' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'reference', label: 'Reference' },
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'website', label: 'Website' },
  { key: 'other', label: 'Other' },
];

/** The source key of a lead's `source` text (the CRM's canonical values, and the legacy spellings the app still coerces). */
export const sourceKeyOf = (source) => {
  const s = String(source ?? '').toLowerCase();
  if (!s.trim()) return 'whatsapp';
  if (s.includes('whatsapp') || s === 'wa') return 'whatsapp';
  if (/\b(ig|instagram)\b/.test(s) && /paid|\bads?\b/.test(s)) return 'meta_ads';
  if (/\b(ig|instagram)\b/.test(s) || s.includes('ig leads')) return s.includes('kerala') ? 'ig_kerala' : 'ig_main';
  if (s.includes('paid') || /\bads?\b/.test(s) || s.includes('trial') || s.includes('meta') || s.includes('facebook')) return 'meta_ads';
  if (/\bweb ?site\b|\bweb ?form\b|\blanding page\b/.test(s)) return 'website';
  if (s.includes('youtube')) return 'youtube';
  if (s.includes('reference') || s.includes('referral')) return 'reference';
  if (s.includes('walk')) return 'walk_in';
  return 'other';
};
export const sourceLabelOf = (key) => SOURCES.find((x) => x.key === key)?.label ?? 'Other';

/** An organic Instagram lead: one of the two Instagram pages (not an ad). */
export const isOrganicInstagram = (source) => ['ig_main', 'ig_kerala'].includes(sourceKeyOf(source));

const KERALA_RX = /kerala|calicut|kozhikode|kochi|ernakulam|malappuram|thrissur|kannur|palakkad|wayanad/i;

/** Main or Kerala: the lead's campaign names it; else the Instagram page; otherwise the region / district decides. */
export const leadBrand = (lead) => {
  if (lead.campaignBrand === 'kerala' || lead.campaignBrand === 'main') return lead.campaignBrand;
  const k = sourceKeyOf(lead.source);
  if (k === 'ig_kerala') return 'kerala';
  if (k === 'ig_main') return 'main';
  return KERALA_RX.test(`${lead.region ?? ''} ${lead.district ?? ''}`) ? 'kerala' : 'main';
};
