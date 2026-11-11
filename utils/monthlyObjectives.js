// Monthly objectives per department — the rules that need no database (tests/monthlyObjectives.test.js).
//
// Each department sets objectives for a month; each objective has key results (a target and a current value) and its progress is
// their average attainment (utils/okrProgress.js, shared with the company OKRs). At the month's end the head closes each objective
// (achieved / partly / missed) and carries what is unfinished into the next month.
//
// Four situations the plain "number to reach, then a result" does not cover:
//   • a key result that is not a number — `kind`: number | percent | yes/no;
//   • a result that differs from what the progress says — the server suggests one (`suggestedResult`), choosing another needs a note;
//   • the plan changing — an objective can be cancelled, postponed, and (once its month has started) edited only with a reason,
//     which is kept as a change log;
//   • an objective that takes several months — `span`: progress keeps its running total when carried, and a month that is not the
//     last one ends as "continues" rather than being scored.
import crypto from 'node:crypto';
import { krAttainment, objectiveProgress } from './okrProgress.js';
import { istMonthKey } from './istDate.js';

export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const SCORED_RESULTS = ['achieved', 'partly', 'missed'];
/// How a month's objective ended. `continued` (a several-month objective with months to go), `cancelled` (dropped) and `deferred`
/// (postponed to the next month) are not scored: they are left out of the month's average progress.
export const RESULTS = [...SCORED_RESULTS, 'continued', 'cancelled', 'deferred'];
export const UNSCORED_RESULTS = ['cancelled', 'deferred'];
export const KR_KINDS = ['number', 'percent', 'yesno'];
export const MAX_KEY_RESULTS = 8;
export const MAX_SPAN_MONTHS = 24;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month) => MONTH_NAMES[month - 1] ?? '';
export const monthLabel = ({ year, month }) => `${monthName(month)} ${year}`;

// ── months (IST: the company runs on Indian time, and a UTC server is still on the old month for the first 5½ hours of the 1st)

/// The IST calendar month an instant falls in.
export const istMonthOf = (now = new Date()) => {
  const [y, m] = istMonthKey(now).split('-').map(Number);
  return { year: y, month: m };
};

export const prevMonth = ({ year, month }) => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });
export const nextMonth = ({ year, month }) => (month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 });

/// <0 when a is earlier than b.
export const compareMonth = (a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month);

/// How many months from a to b (negative when b is earlier).
export const monthsBetween = (a, b) => (b.year - a.year) * 12 + (b.month - a.month);

export const addMonths = ({ year, month }, n) => {
  const idx = year * 12 + (month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
};

/// A stable date for a month, to dedupe a notification by (month) — the 1st, midnight UTC.
export const monthKey = ({ year, month }) => new Date(Date.UTC(year, month - 1, 1));

/// year / month from a request, defaulting to the current IST month. → { ok, value } | { ok: false, message }
export const parseMonth = (rawYear, rawMonth, now = new Date()) => {
  const cur = istMonthOf(now);
  const year = rawYear === undefined || rawYear === '' || rawYear === null ? cur.year : Number(rawYear);
  const month = rawMonth === undefined || rawMonth === '' || rawMonth === null ? cur.month : Number(rawMonth);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return { ok: false, message: 'Choose a year between 2020 and 2100.' };
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, message: 'The month must be 1 to 12.' };
  return { ok: true, value: { year, month } };
};

// ── input ────────────────────────────────────────────────────────────────────

const text = (v) => String(v ?? '').trim();
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
export const newId = () => crypto.randomBytes(6).toString('hex');

const KIND_LABEL = { number: 'number', percent: 'percent', yesno: 'yes/no' };

/// One key result from a request. A percent one is out of 100 and a yes/no one is done or not, so neither takes a target from the
/// form. → { value } | { error }
const keyResultInput = (raw, i) => {
  const label = `Key result ${i + 1}`;
  const title = text(raw?.title);
  if (!title) return { error: `${label} needs a title.` };
  if (title.length > 200) return { error: `${label}'s title is too long (200 characters at most).` };
  const kind = text(raw?.kind).toLowerCase() || 'number';
  if (!KR_KINDS.includes(kind)) return { error: `${label}'s type must be number, percent or yes/no.` };

  const hasCurrent = raw?.currentValue !== undefined && raw?.currentValue !== null && raw?.currentValue !== '';
  let target;
  let unit = text(raw?.unit).slice(0, 30);
  let current = 0;
  if (kind === 'yesno') {
    target = 1;
    unit = '';
  } else {
    target = kind === 'percent' ? 100 : num(raw?.targetValue);
    if (kind === 'percent') unit = '%';
    if (!Number.isFinite(target) || target <= 0) return { error: `${label} needs a target above zero.` };
    current = hasCurrent ? num(raw.currentValue) : 0;
    if (!Number.isFinite(current) || current < 0) return { error: `${label}'s current value cannot be negative.` };
    if (kind === 'percent' && current > 100) return { error: `${label}'s percentage cannot be above 100.` };
  }
  return {
    value: {
      id: text(raw?.id),
      title,
      kind,
      metric: text(raw?.metric).slice(0, 100),
      unit,
      targetValue: round2(target),
      currentValue: round2(current),
      hasCurrent: kind === 'yesno' ? false : hasCurrent,
      completed: raw?.completed === true,
    },
  };
};

/**
 * What the create / edit forms send. `partial` (an edit) only checks what is present.
 * → { ok: true, value } | { ok: false, message }
 */
export const validateObjectiveInput = (body, { partial = false } = {}) => {
  const out = {};
  if (!partial || body?.objective !== undefined) {
    const objective = text(body?.objective);
    if (!objective) return { ok: false, message: 'Give the objective a title.' };
    if (objective.length > 200) return { ok: false, message: 'The title is too long (200 characters at most).' };
    out.objective = objective;
  }
  if (body?.description !== undefined) {
    const d = text(body.description);
    if (d.length > 2000) return { ok: false, message: 'The description is too long (2000 characters at most).' };
    out.description = d;
  }
  if (body?.priority !== undefined) {
    const p = text(body.priority).toLowerCase();
    if (!PRIORITIES.includes(p)) return { ok: false, message: `Priority must be one of ${PRIORITIES.join(', ')}.` };
    out.priority = p;
  }
  if (body?.ownerId !== undefined) out.ownerId = text(body.ownerId) || null;
  if (body?.spanMonths !== undefined) {
    const raw = body.spanMonths;
    const n = raw === null || raw === '' ? 1 : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SPAN_MONTHS) return { ok: false, message: `A multi-month objective runs 2 to ${MAX_SPAN_MONTHS} months.` };
    out.spanMonths = n;
  }

  if (body?.keyResults !== undefined) {
    if (!Array.isArray(body.keyResults)) return { ok: false, message: 'Key results must be a list.' };
    if (body.keyResults.length > MAX_KEY_RESULTS) return { ok: false, message: `An objective can have ${MAX_KEY_RESULTS} key results at most.` };
    const list = [];
    for (let i = 0; i < body.keyResults.length; i++) {
      const r = keyResultInput(body.keyResults[i], i);
      if (r.error) return { ok: false, message: r.error };
      list.push(r.value);
    }
    out.keyResults = list;
  }
  return { ok: true, value: out };
};

/**
 * The key results to store after an edit: the ones sent, in the order sent. A key result that already exists keeps its id, its
 * check-ins and — unless the form sent a value of its own — its current value; a new one gets an id; one left out is removed.
 *
 * Done-ness follows the numbers when the target moves: raise a number's target past what was reached and it is open again (it
 * would otherwise show 100% at 40 of 60); lower it to what was reached and it is done. A key result that is done only because it was
 * ticked stays done when nothing about its target changed. `stamp` ({ at, by, byName }) is who/when for any key result that becomes
 * done in this edit; one that stops being done loses its stamp.
 */
export const mergeKeyResults = (existing, incoming, stamp) => {
  const byId = new Map((existing ?? []).map((k) => [String(k.id), k]));
  const stamped = (k, wasDone, old) => {
    if (!k.completed) return { ...k, completedAt: null, completedBy: null, completedByName: '' };
    if (!wasDone) return { ...k, completedAt: stamp?.at ?? null, completedBy: stamp?.by ?? null, completedByName: stamp?.byName ?? '' };
    return { ...k, completedAt: old?.completedAt ?? null, completedBy: old?.completedBy ?? null, completedByName: old?.completedByName ?? '' };
  };
  return incoming.map((k) => {
    const old = k.id ? byId.get(k.id) : undefined;
    const { hasCurrent, ...rest } = k;
    if (!old) return stamped({ ...rest, id: newId(), checkIns: [] }, false, null);
    const wasDone = old.completed === true;
    // changing what kind of key result it is starts it afresh: a count of 20 means nothing as a percentage or a yes/no
    if ((old.kind ?? 'number') !== rest.kind) {
      return stamped({ ...rest, id: String(old.id), currentValue: hasCurrent ? rest.currentValue : 0, completed: rest.completed, checkIns: old.checkIns ?? [] }, wasDone, old);
    }
    const currentValue = hasCurrent ? rest.currentValue : old.currentValue ?? 0;
    const targetMoved = rest.kind === 'number' && Number(old.targetValue) !== Number(rest.targetValue);
    const completed = targetMoved && !rest.completed ? currentValue >= rest.targetValue : rest.completed || wasDone;
    return stamped({ ...rest, id: String(old.id), currentValue, completed, checkIns: old.checkIns ?? [] }, wasDone, old);
  });
};

/// A check-in: a new current value and/or "done". A yes/no key result is only ever done or not; a percentage stops at 100.
/// → { ok, value: { currentValue, completed } } | { ok: false, message }
export const validateCheckIn = (body, kr) => {
  const kind = kr.kind ?? 'number';
  const hasValue = body?.value !== undefined && body?.value !== null && body?.value !== '';
  const hasDone = body?.completed !== undefined;
  if (kind === 'yesno') {
    if (!hasDone) return { ok: false, message: 'Mark it done or not done.' };
    const done = body.completed === true;
    return { ok: true, value: { currentValue: done ? 1 : 0, completed: done } };
  }
  if (!hasValue && !hasDone) return { ok: false, message: 'Send the new value, or mark it done.' };
  let currentValue = kr.currentValue ?? 0;
  if (hasValue) {
    const v = num(body.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, message: 'The value cannot be negative.' };
    if (kind === 'percent' && v > 100) return { ok: false, message: 'A percentage cannot be above 100.' };
    currentValue = round2(v);
  }
  // reaching the target is done; so is being ticked. Un-ticking a key result that is under target puts it back to open.
  const completed = hasDone ? body.completed === true : currentValue >= (kr.targetValue ?? Infinity);
  return { ok: true, value: { currentValue, completed } };
};

// ── reading ──────────────────────────────────────────────────────────────────

/// An objective's progress (0–100): its key results' average; with none, 0 (a closed one keeps what it reached).
export const progressOf = (objective) => objectiveProgress(objective.keyResults ?? [], 0);

/// Where a several-month objective stands in its run — null for an ordinary one-month objective.
/// → { number: this is month n, total: of m, final: this is the last planned month, overran: past it }
export const spanInfo = (o) => {
  const s = o?.span;
  if (!s || !s.endYear) return null;
  const total = monthsBetween({ year: s.startYear, month: s.startMonth }, { year: s.endYear, month: s.endMonth }) + 1;
  const number = monthsBetween({ year: s.startYear, month: s.startMonth }, { year: o.year, month: o.month }) + 1;
  return { number, total, final: number >= total, overran: number > total };
};

/// The span to store for an objective in [month] that runs [months] months in all (counting from [existing]'s start, so a carried
/// one keeps its own beginning). One month or fewer means an ordinary objective → { value: null }. → { value } | { error }
export const buildSpan = (month, months, existing) => {
  if (!months || months < 2) return { value: null };
  const start = existing?.startYear ? { year: existing.startYear, month: existing.startMonth } : month;
  const end = addMonths(start, months - 1);
  if (compareMonth(end, month) < 0) return { error: 'The planned finish cannot be before the month this objective is in.' };
  return { value: { startYear: start.year, startMonth: start.month, endYear: end.year, endMonth: end.month } };
};

/**
 * The result the progress points to, which is where the close-out starts: all key results done is achieved, half way partly, less
 * missed — except a several-month objective with months still to go, which simply continues. With no key results there is nothing
 * to measure, so no suggestion (null) and any result is fine.
 */
export const suggestedResult = (o) => {
  if ((o.keyResults ?? []).length === 0) return null;
  const p = progressOf(o);
  if (p >= 100) return 'achieved';
  const span = spanInfo(o);
  if (span && !span.final) return 'continued';
  return p >= 50 ? 'partly' : 'missed';
};

/**
 * Is every key result done, so the head could close it as achieved? Counted by attainment — a number that reached its target is done
 * even if nobody ticked it. Not for one that is already closed or has no key results, nor for a several-month objective with months
 * still to go: finishing that early is a decision for the close-out, not a one-tap.
 */
export const isReadyToClose = (o) => {
  if (o.result) return false;
  const krs = o.keyResults ?? [];
  if (krs.length === 0 || !krs.every((k) => krAttainment(k) >= 100)) return false;
  const span = spanInfo(o);
  return !(span && !span.final);
};

/// How a set of objectives is doing: count, average progress, and how many are open / closed by result. Cancelled and postponed
/// objectives are no longer this month's plan, so they stay out of the average.
export const summarize = (objectives) => {
  const list = objectives ?? [];
  const closed = list.filter((o) => o.result);
  const counted = list.filter((o) => !UNSCORED_RESULTS.includes(o.result));
  const n = (r) => list.filter((o) => o.result === r).length;
  return {
    count: list.length,
    avgProgress: counted.length ? Math.round(counted.reduce((s, o) => s + progressOf(o), 0) / counted.length) : 0,
    open: list.length - closed.length,
    closed: closed.length,
    achieved: n('achieved'),
    partly: n('partly'),
    missed: n('missed'),
    continued: n('continued'),
    cancelled: n('cancelled'),
    deferred: n('deferred'),
  };
};

// ── the trend: how each month went ──────────────────────────────────────────

export const TREND_DEFAULT_MONTHS = 6;
export const TREND_MAX_MONTHS = 12;

/// The [count] months that end with [end], oldest first.
export const trendMonths = (end, count = TREND_DEFAULT_MONTHS) => {
  const n = Math.min(TREND_MAX_MONTHS, Math.max(2, Number.isInteger(count) ? count : TREND_DEFAULT_MONTHS));
  return Array.from({ length: n }, (_, i) => addMonths(end, i - (n - 1)));
};

/**
 * How each of [months] went: for the whole company (the departments given) and for each department — how many objectives, and how
 * far they got on average (cancelled and postponed ones stay out of the average, as everywhere). A month with nothing set has
 * `count: 0`; its average means nothing, so the app leaves a gap rather than a 0%.
 * @param {{ year, month }[]} months   oldest first
 * @param {object[]} objectives        MonthlyObjective documents (any months; others are ignored)
 * @param {{ id, name }[]} departments the departments to report on
 */
export const trendSeries = ({ months, objectives, departments }) =>
  months.map((m) => {
    const inMonth = objectives.filter((o) => o.year === m.year && o.month === m.month && departments.some((d) => String(d.id) === String(o.departmentId)));
    const whole = summarize(inMonth);
    return {
      year: m.year,
      month: m.month,
      count: whole.count,
      avgProgress: whole.avgProgress,
      closed: whole.closed,
      achieved: whole.achieved,
      departments: departments.map((d) => {
        const mine = inMonth.filter((o) => String(o.departmentId) === String(d.id));
        const s = summarize(mine);
        return { departmentId: String(d.id), name: d.name, count: s.count, avgProgress: s.avgProgress, closed: s.closed };
      }),
    };
  });

// ── the plan changing ────────────────────────────────────────────────────────

const quote = (t) => `“${t}”`;

/**
 * What changed in the plan between two versions of an objective, worth keeping a record of: the title, key results added or taken
 * out, and a key result's name, type or target. (Description, priority and owner are not the plan.) → [string]
 */
export const planChanges = (before, after) => {
  const out = [];
  if (after.objective !== undefined && after.objective !== before.objective) out.push(`Title: ${quote(before.objective)} → ${quote(after.objective)}`);
  if (after.keyResults !== undefined) {
    const old = new Map((before.keyResults ?? []).map((k) => [String(k.id), k]));
    const kept = new Set();
    for (const k of after.keyResults) {
      const o = old.get(String(k.id));
      if (!o) {
        out.push(`Added key result ${quote(k.title)}`);
        continue;
      }
      kept.add(String(k.id));
      if (o.title !== k.title) out.push(`Key result ${quote(o.title)} renamed ${quote(k.title)}`);
      const was = o.kind ?? 'number';
      if (was !== k.kind) out.push(`${quote(k.title)} changed from ${KIND_LABEL[was]} to ${KIND_LABEL[k.kind]}`);
      else if (k.kind === 'number' && Number(o.targetValue) !== Number(k.targetValue)) out.push(`${quote(k.title)} target ${o.targetValue} → ${k.targetValue}`);
    }
    for (const [id, o] of old) if (!kept.has(id)) out.push(`Removed key result ${quote(o.title)}`);
  }
  return out;
};

// ── carrying over ────────────────────────────────────────────────────────────

/// Is anything left to do on this objective? Not if it was achieved or cancelled; with key results, only if one is unfinished.
export const hasWorkLeft = (o) => {
  if (o.result === 'achieved' || o.result === 'cancelled') return false;
  const krs = o.keyResults ?? [];
  return krs.length === 0 || krs.some((k) => krAttainment(k) < 100);
};

/// One key result for the next month. An ordinary objective carries what is LEFT of each unfinished key result, starting again from
/// zero — except a percentage, which carries on from where it got to (it is already a share of the whole), and a yes/no, which
/// is simply still not done. A several-month objective keeps every key result and its running total.
const carriedKeyResult = (k, running) => {
  const kind = k.kind ?? 'number';
  const base = { id: newId(), title: k.title, kind, metric: k.metric ?? '', unit: k.unit ?? '', checkIns: [] };
  if (running) {
    const done = k.completed === true;
    // a key result finished in an earlier month keeps its who / when
    return { ...base, targetValue: k.targetValue, currentValue: k.currentValue ?? 0, completed: done, completedAt: done ? k.completedAt ?? null : null, completedBy: done ? k.completedBy ?? null : null, completedByName: done ? k.completedByName ?? '' : '' };
  }
  if (kind === 'yesno') return { ...base, targetValue: 1, currentValue: 0, completed: false };
  if (kind === 'percent') return { ...base, targetValue: 100, currentValue: k.currentValue ?? 0, completed: false };
  return { ...base, targetValue: Math.max(0.01, round2((k.targetValue ?? 0) - (k.currentValue ?? 0))), currentValue: 0, completed: false };
};

/**
 * What to create in the next month for the unfinished objectives: the same title, description, owner and priority, and the key
 * results as [carriedKeyResult] works them out. An objective already carried (`carriedToId`) is skipped, so pressing the button
 * twice makes it once; so is one that was achieved or cancelled.
 * → { items: [{ fromId, objective, description, ownerId, ownerName, priority, span, keyResults }], skipped: [{ id, reason }] }
 */
export const carryOverPlan = (objectives) => {
  const items = [];
  const skipped = [];
  for (const o of objectives) {
    const id = String(o._id ?? o.id);
    if (o.carriedToId) {
      skipped.push({ id, reason: 'already carried over' });
      continue;
    }
    if (!hasWorkLeft(o)) {
      skipped.push({ id, reason: o.result === 'achieved' ? 'achieved' : o.result === 'cancelled' ? 'cancelled' : 'nothing left' });
      continue;
    }
    const running = !!spanInfo(o);
    items.push({
      fromId: id,
      objective: o.objective,
      description: o.description ?? '',
      ownerId: o.ownerId ?? null,
      ownerName: o.ownerName ?? '',
      priority: o.priority ?? 'medium',
      span: running ? { startYear: o.span.startYear, startMonth: o.span.startMonth, endYear: o.span.endYear, endMonth: o.span.endMonth } : null,
      keyResults: (o.keyResults ?? []).filter((k) => running || krAttainment(k) < 100).map((k) => carriedKeyResult(k, running)),
    });
  }
  return { items, skipped };
};

// ── reminders ────────────────────────────────────────────────────────────────

/**
 * Who to remind, and about what. A head who leads two departments gets ONE message for each kind, naming both — a notification is
 * deduped per person, type and month, so two would collapse into one and the second department would go unmentioned.
 *
 *   departments: [{ id, name, headUserIds: [..] }]
 *   thisMonth:   Map(deptId → number of objectives set for the current month)
 *   lastMonth:   Map(deptId → { count, open }) for the month before
 * → [{ userId, set: [department names with nothing set this month], close: [department names with last month still open] }]
 */
export const reminderPlan = ({ departments, thisMonth, lastMonth }) => {
  const byUser = new Map();
  const entry = (userId) => {
    const k = String(userId);
    if (!byUser.has(k)) byUser.set(k, { userId: k, set: [], close: [] });
    return byUser.get(k);
  };
  for (const d of departments) {
    const id = String(d.id);
    const needsSetting = (thisMonth.get(id) ?? 0) === 0;
    const last = lastMonth.get(id);
    const needsClosing = !!last && last.count > 0 && last.open > 0;
    if (!needsSetting && !needsClosing) continue;
    for (const userId of d.headUserIds ?? []) {
      const e = entry(userId);
      if (needsSetting) e.set.push(d.name);
      if (needsClosing) e.close.push(d.name);
    }
  }
  for (const e of byUser.values()) {
    e.set.sort();
    e.close.sort();
  }
  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
};

const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/// The wording of a reminder, for the month it is about.
export const reminderText = (kind, names, month) => {
  const label = monthLabel(month);
  const many = names.length > 1;
  if (kind === 'set') {
    return { title: `Set ${label}'s objectives`, body: `${joinNames(names)} ${many ? 'have' : 'has'} no objectives for ${label} yet. Add them so the month starts with a plan.` };
  }
  return { title: `Close out ${label}`, body: `${joinNames(names)} still ${many ? 'have' : 'has'} ${label} objectives open. Mark each Achieved, Partly or Missed, and carry the rest over.` };
};
