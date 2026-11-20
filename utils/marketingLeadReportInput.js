import { isDay } from './marketingActivityInput.js';
import { addDays, daysBetween } from './marketingTeamStats.js';
import { FOLLOWUP_FILTERS, LEAD_SORTS, REPORTS, SOURCE_GROUPS } from './marketingLeadReportStats.js';

// Checking what the Lead Report's screens send (pure — tests/marketingLeadReportStats.test.js). Everything arrives as a query string, so
// every value must be a single string (`?from=a&from=b` is an array and is refused). Each check returns { ok, value } or
// { ok: false, message, field } — the message is in plain words and is shown to the user.

const fail = (message, field) => ({ ok: false, message, field });
const BRANDS = ['all', 'main', 'kerala'];
const STAGE_FILTERS = ['all', 'new', 'in_progress', 'not_converted', 'converted'];
const GROUP_FILTERS = ['all', ...SOURCE_GROUPS.map((g) => g.key)];

const one = (v) => (v === undefined ? undefined : typeof v === 'string' ? v : null);

/** The Monday–Sunday week of an IST day. */
const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = addDays(day, -((dow + 6) % 7));
  return { from: monday, to: addDays(monday, 6) };
};

/** ?from=&to=&brand= → { from, to, brand }. No dates = this week; no brand = all. At most a year. */
export const cleanRange = (query = {}, today) => {
  const dflt = weekOf(today);
  const f = one(query.from);
  const t = one(query.to);
  const b = one(query.brand);
  if (f === null || t === null || b === null) return fail('Send each filter once.', 'range');
  const from = f ?? dflt.from;
  const to = t ?? dflt.to;
  if (!isDay(from) || !isDay(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return fail('The dates must be YYYY-MM-DD.', 'from');
  if (to < from) return fail('The end date is before the start date.', 'to');
  if (daysBetween(from, to) > 366) return fail('Choose a range of a year or less.', 'to');
  const brand = String(b ?? 'all').toLowerCase();
  if (!BRANDS.includes(brand)) return fail('Choose All, Main or Kerala.', 'brand');
  return { ok: true, value: { from, to, brand } };
};

const whole = (v, name, dflt, { min = 1, max = 100 } = {}) => {
  const s = one(v);
  if (s === null) return fail(`Send ${name} once.`, name);
  if (s === undefined || s === '') return { ok: true, value: dflt };
  if (!/^\d{1,6}$/.test(s)) return fail(`${name} must be a whole number.`, name);
  return { ok: true, value: Math.min(Math.max(Number(s), min), max) };
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * The All Leads list: stage chip, source group, assigned to ('all' | 'unassigned' | a user id), campaign ('all' | 'none' | a campaign id),
 * search, sort, direction, page, page size.
 */
export const cleanLeadListQuery = (query = {}) => {
  const stage = one(query.stage) ?? 'all';
  const group = one(query.source) ?? 'all';
  const assignee = one(query.assignee) ?? 'all';
  const campaign = one(query.campaign) ?? 'all';
  const q = one(query.q) ?? '';
  const sort = one(query.sort) ?? 'created';
  const dir = one(query.dir) ?? '';
  if ([one(query.stage), one(query.source), one(query.assignee), one(query.campaign), one(query.q), one(query.sort), one(query.dir)].includes(null)) return fail('Send each filter once.', 'filter');
  if (!['all', 'unassigned'].includes(assignee) && !OBJECT_ID.test(assignee)) return fail('Choose a person from the Assigned to list.', 'assignee');
  if (!['all', 'none'].includes(campaign) && !OBJECT_ID.test(campaign)) return fail('Choose a campaign from the list.', 'campaign');
  if (!STAGE_FILTERS.includes(stage)) return fail('Choose All, New, In Progress, Not Converted or Converted.', 'stage');
  if (!GROUP_FILTERS.includes(group)) return fail('That source is not one of the source groups.', 'source');
  if (!LEAD_SORTS.includes(sort)) return fail(`Sort by ${LEAD_SORTS.join(', ')}.`, 'sort');
  if (dir && !['asc', 'desc'].includes(dir)) return fail('The sort direction is asc or desc.', 'dir');
  const page = whole(query.page, 'page', 1, { max: 100000 });
  if (!page.ok) return page;
  const limit = whole(query.limit, 'limit', 10, { max: 100 });
  if (!limit.ok) return limit;
  return { ok: true, value: { stage, group, assignee: assignee.toLowerCase(), campaign: campaign.toLowerCase(), q: q.trim().slice(0, 100), sort, dir, page: page.value, limit: limit.value } };
};

/** The Follow-ups list: chip, page, page size. */
export const cleanFollowUpQuery = (query = {}) => {
  const filter = one(query.filter) ?? 'all';
  if (one(query.filter) === null) return fail('Send each filter once.', 'filter');
  if (!FOLLOWUP_FILTERS.includes(filter)) return fail('Choose All, Today, Overdue, Upcoming or Completed.', 'filter');
  const page = whole(query.page, 'page', 1, { max: 100000 });
  if (!page.ok) return page;
  const limit = whole(query.limit, 'limit', 10, { max: 100 });
  if (!limit.ok) return limit;
  return { ok: true, value: { filter, page: page.value, limit: limit.value } };
};

/** :type of /reports/:type. */
export const cleanReportType = (type) => (REPORTS.some((r) => r.key === type) ? { ok: true, value: type } : fail('That report does not exist.', 'type'));
