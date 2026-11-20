import mongoose from 'mongoose';
import { INITIATIVE_STATUSES, IMPACTS } from '../models/StrategicInitiative.js';
import { DEV_PROJECT_STATUSES } from '../models/DevProject.js';
import { PLAN_STATUSES } from '../models/StrategicPlan.js';
import { FINDING_KINDS } from '../models/ResearchFinding.js';
import { REVIEW_TYPES, OUTCOME_STATES, ACTION_STATUSES, ACTION_PRIORITIES, REVIEW_LINK_KINDS } from '../models/StrategyReview.js';
import { isDay } from './marketingActivityInput.js';
import { httpUrl } from './marketingSocialsInput.js';
import { addDays, daysBetween } from './marketingTeamStats.js';

// Checking what the app sends for the Strategies & Developments records (pure — tests/marketingStrategyInput.test.js). Every text is data
// (trimmed, capped); links must be http(s); ids must be real ObjectIds (that they point at something is checked by the controller).
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const BRANDS = ['main', 'kerala'];
const blank = (v) => v === null || v === undefined || v === '';

const idOrNull = (v) => (blank(v) ? null : mongoose.isValidObjectId(String(v)) && String(v).length === 24 ? String(v) : undefined);

/** ?from=&to=&brand= → { from, to, brand } (this month by default) or a refusal. `today` is the IST day. */
export const cleanRangeQuery = (q = {}, today) => {
  const first = `${today.slice(0, 8)}01`;
  const last = addDays(`${addDays(first, 31).slice(0, 8)}01`, -1);
  const from = q.from ?? first;
  const to = q.to ?? last;
  if (!isDay(from) || !isDay(to)) return fail('The dates must be YYYY-MM-DD.', 'from');
  if (to < from) return fail('The end date is before the start date.', 'to');
  if (daysBetween(from, to) > 366) return fail('Choose a range of a year or less.', 'to');
  const brand = String(q.brand ?? 'all').toLowerCase();
  if (!['all', ...BRANDS].includes(brand)) return fail('Choose All, Main or Kerala.', 'brand');
  return { ok: true, value: { from, to, brand } };
};

/** A year (2000–2100) from a query/body value; `fallback` when absent. */
export const cleanYear = (v, fallback) => {
  if (blank(v)) return { ok: true, value: fallback };
  const n = Number(v);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? { ok: true, value: n } : fail('Choose a year between 2000 and 2100.', 'year');
};

/** The title/name every record needs. */
const title = (b, key, label, out) => {
  out[key] = str(b[key], 200);
  return out[key].length < 2 ? fail(`Give the ${label} a ${key === 'name' ? 'name' : 'title'}.`, key) : null;
};

const optDay = (b, key, label, out) => {
  if (b[key] === undefined) return null;
  if (blank(b[key])) {
    out[key] = null;
    return null;
  }
  if (!isDay(b[key])) return fail(`The ${label} must be a real day.`, key);
  out[key] = b[key];
  return null;
};

const optId = (b, key, label, out) => {
  if (b[key] === undefined) return null;
  const id = idOrNull(b[key]);
  if (id === undefined) return fail(`That ${label} is not valid.`, key);
  out[key] = id;
  return null;
};

const optProgress = (b, out) => {
  if (b.progress === undefined) return null;
  if (blank(b.progress)) {
    out.progress = null;
    return null;
  }
  const n = Number(b.progress);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) return fail('Progress is a whole number from 0 to 100.', 'progress');
  out.progress = n;
  return null;
};

const enumField = (b, key, list, message, out) => {
  if (b[key] === undefined) return null;
  if (!list.includes(b[key])) return fail(message, key);
  out[key] = b[key];
  return null;
};

/** The start/due pair has to run forwards (checked on what the record will hold after the change). */
const orderOk = (existing, out, startKey, endKey) => {
  const start = out[startKey] !== undefined ? out[startKey] : existing?.[startKey];
  const end = out[endKey] !== undefined ? out[endKey] : existing?.[endKey];
  return start && end && end < start ? fail('The due date is before the start date.', endKey) : null;
};

const firstFail = (...checks) => checks.find(Boolean) ?? null;

/** An initiative from a request body. `existing` set = an update (only what was sent changes). */
export const cleanInitiativeInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f =
    firstFail(
      has('title') || !existing ? title(b, 'title', 'initiative', out) : null,
      enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out),
      enumField(b, 'status', INITIATIVE_STATUSES, 'Unknown initiative status.', out),
      enumField(b, 'impact', IMPACTS, 'Impact is High, Medium or Low.', out),
      optDay(b, 'startDate', 'start date', out),
      optDay(b, 'dueDate', 'due date', out),
      optProgress(b, out),
      optId(b, 'ownerId', 'owner', out),
      optId(b, 'planId', 'plan', out),
    ) ?? orderOk(existing, out, 'startDate', 'dueDate');
  if (f) return f;
  if (has('focusArea')) out.focusArea = str(b.focusArea, 120);
  if (has('description')) out.description = str(b.description, 1000);
  if (has('notes')) out.notes = str(b.notes, 2000);
  return { ok: true, value: out };
};

/** A development project from a request body. */
export const cleanProjectInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f =
    firstFail(
      has('name') || !existing ? title(b, 'name', 'project', out) : null,
      enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out),
      enumField(b, 'status', DEV_PROJECT_STATUSES, 'Unknown project status.', out),
      optDay(b, 'startDate', 'start date', out),
      optDay(b, 'endDate', 'due date', out),
      optProgress(b, out),
      optId(b, 'ownerId', 'owner', out),
      optId(b, 'planId', 'plan', out),
    ) ?? orderOk(existing, out, 'startDate', 'endDate');
  if (f) return f;
  if (has('category')) out.category = str(b.category, 80);
  if (has('description')) out.description = str(b.description, 1000);
  if (has('notes')) out.notes = str(b.notes, 2000);
  return { ok: true, value: out };
};

/** A strategic plan from a request body (a new plan needs a title, a focus area and a year). */
export const cleanPlanInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f = firstFail(
    has('title') || !existing ? title(b, 'title', 'plan', out) : null,
    enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out),
    enumField(b, 'status', PLAN_STATUSES, 'Unknown plan status.', out),
    optId(b, 'ownerId', 'owner', out),
  );
  if (f) return f;
  if (has('focusArea') || !existing) {
    out.focusArea = str(b.focusArea, 120);
    if (!out.focusArea) return fail('Choose the focus area of the plan.', 'focusArea');
  }
  if (has('year') || !existing) {
    const y = cleanYear(b.year, null);
    if (!y.ok || y.value === null) return fail('Choose the year of the plan (2000–2100).', 'year');
    out.year = y.value;
  }
  if (has('goals')) {
    if (!Array.isArray(b.goals)) return fail('The goals must be a list.', 'goals');
    const goals = b.goals.map((g) => str(g, 200)).filter(Boolean);
    if (goals.length > 12) return fail('Add at most 12 goals to a plan.', 'goals');
    out.goals = goals;
  }
  if (has('description')) out.description = str(b.description, 1000);
  return { ok: true, value: out };
};

/** One roadmap line (a milestone in a quarter). */
export const cleanRoadmapInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f = firstFail(
    has('title') || !existing ? title(b, 'title', 'roadmap line', out) : null,
    enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out),
    optId(b, 'planId', 'plan', out),
    optId(b, 'initiativeId', 'initiative', out),
  );
  if (f) return f;
  if (has('year') || !existing) {
    const y = cleanYear(b.year, null);
    if (!y.ok || y.value === null) return fail('Choose the year (2000–2100).', 'year');
    out.year = y.value;
  }
  if (has('quarter') || !existing) {
    const q = Number(b.quarter);
    if (!Number.isInteger(q) || q < 1 || q > 4) return fail('Choose the quarter, 1 to 4.', 'quarter');
    out.quarter = q;
  }
  if (has('theme')) out.theme = str(b.theme, 80);
  return { ok: true, value: out };
};

const cleanTags = (list) => [...new Set((Array.isArray(list) ? list : String(list ?? '').split(',')).map((t) => str(t, 40).toLowerCase()).filter(Boolean))].slice(0, 10);

/** A research finding. The day defaults to `today` for a new one (the controller passes it). */
export const cleanFindingInput = (b = {}, existing = null, { today } = {}) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f = firstFail(has('title') || !existing ? title(b, 'title', 'finding', out) : null, enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out), optDay(b, 'date', 'date', out));
  if (f) return f;
  if (has('kind') || !existing) {
    if (!FINDING_KINDS.includes(b.kind)) return fail('Choose what kind of finding it is.', 'kind');
    out.kind = b.kind;
  }
  if (out.date === null) return fail('Choose the day of the finding.', 'date');
  if (!existing && out.date === undefined) out.date = today;
  if (has('summary')) out.summary = str(b.summary, 2000);
  if (has('link')) {
    out.link = httpUrl(b.link);
    if (str(b.link, 1000) && !out.link) return fail('The link must start with https://.', 'link');
  }
  if (has('tags')) out.tags = cleanTags(b.tags);
  return { ok: true, value: out };
};

const cleanOutcomes = (list) => {
  if (!Array.isArray(list)) return fail('The outcomes must be a list.', 'outcomes');
  if (list.length > 30) return fail('Add at most 30 outcomes to a review.', 'outcomes');
  const out = [];
  for (const o of list) {
    const text = str(o?.text, 300);
    if (!text) continue;
    if (!OUTCOME_STATES.includes(o?.state)) return fail('Each outcome is Achieved, Partially achieved or Not achieved.', 'outcomes');
    out.push({ text, state: o.state });
  }
  if (!out.length) return fail('Add at least one outcome — the score is counted from them.', 'outcomes');
  return { ok: true, value: out };
};

const cleanActions = (list) => {
  if (!Array.isArray(list)) return fail('The action items must be a list.', 'actionItems');
  if (list.length > 30) return fail('Add at most 30 action items to a review.', 'actionItems');
  const out = [];
  for (const a of list) {
    const text = str(a?.text, 300);
    if (!text) continue;
    const owner = idOrNull(a?.ownerId);
    if (owner === undefined) return fail('An action item\'s owner is not valid.', 'actionItems');
    const priority = a?.priority ?? 'medium';
    const status = a?.status ?? 'open';
    if (!ACTION_PRIORITIES.includes(priority)) return fail('An action item\'s priority is High, Medium or Low.', 'actionItems');
    if (!ACTION_STATUSES.includes(status)) return fail('An action item is Open, In progress or Done.', 'actionItems');
    if (!blank(a?.targetDate) && !isDay(a.targetDate)) return fail('An action item\'s target date must be a real day.', 'actionItems');
    const id = idOrNull(a?.id);
    out.push({ id: id ?? null, text, ownerId: owner, priority, targetDate: blank(a?.targetDate) ? null : a.targetDate, status });
  }
  return { ok: true, value: out };
};

/** A review. `today` is the default review day for a new one. */
export const cleanReviewInput = (b = {}, existing = null, { today } = {}) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const f = firstFail(enumField(b, 'brand', BRANDS, 'Choose Main or Kerala.', out), optDay(b, 'reviewDate', 'review date', out));
  if (f) return f;
  if (has('type') || !existing) {
    if (!REVIEW_TYPES.includes(b.type)) return fail('Choose Strategy, Project, Campaign or Quarterly review.', 'type');
    out.type = b.type;
  }
  if (has('periodLabel') || !existing) {
    out.periodLabel = str(b.periodLabel, 60);
    if (!out.periodLabel) return fail('Name the period or subject of the review (for example Q3 2026).', 'periodLabel');
  }
  if (out.reviewDate === null) return fail('Choose the day of the review.', 'reviewDate');
  if (!existing && out.reviewDate === undefined) out.reviewDate = today;
  if (has('summary')) out.summary = str(b.summary, 2000);
  if (has('outcomes') || !existing) {
    const o = cleanOutcomes(b.outcomes ?? []);
    if (!o.ok) return o;
    out.outcomes = o.value;
  }
  if (has('actionItems')) {
    const a = cleanActions(b.actionItems);
    if (!a.ok) return a;
    out.actionItems = a.value;
  }
  // the record it reviews: { linkKind, linkId } together, or both blank to take the link away (that it exists is the controller's check)
  if (has('linkKind') || has('linkId')) {
    if (blank(b.linkKind) && blank(b.linkId)) {
      out.linkKind = null;
      out.linkId = null;
    } else {
      if (!REVIEW_LINK_KINDS.includes(b.linkKind)) return fail('A review can be about a plan, a development project or an initiative.', 'linkKind');
      const id = idOrNull(b.linkId);
      if (!id) return fail('Choose the plan, project or initiative this review is about.', 'linkId');
      out.linkKind = b.linkKind;
      out.linkId = id;
    }
  }
  return { ok: true, value: out };
};

/** Changing one action item's status (the owner ticks it, or a manager does). */
export const cleanActionStatus = (b = {}) => (ACTION_STATUSES.includes(b.status) ? { ok: true, value: { status: b.status } } : fail('An action item is Open, In progress or Done.', 'status'));

/** Ticking a roadmap line on or off. */
export const cleanTick = (b = {}) => (typeof b.done === 'boolean' ? { ok: true, value: { done: b.done } } : fail('Say whether the line is done or not.', 'done'));

/** The paging every list uses: page ≥ 1 and a size between 1 and 100. */
export const cleanPaging = (q = {}, dflt = 10) => ({ page: Math.max(parseInt(q.page, 10) || 1, 1), limit: Math.min(Math.max(parseInt(q.limit, 10) || dflt, 1), 100) });
