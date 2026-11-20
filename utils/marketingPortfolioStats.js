import { istDay, addDays, eachDay, previousRange, changePct, daysBetween } from './marketingTeamStats.js';

// What the Creative Portfolio screens count — one definition of each number, used by the Shoot Planner, Production Calendar, Shoot
// Reports and Gallery so they agree. Shoots are MarketingShoot records (models/MarketingShoot.js), assets MarketingAsset records;
// days are IST day strings 'YYYY-MM-DD'.
//
//  • A shoot counts on its shoot date. Cancelled shoots count nowhere.
//  • Progress = milestones done ÷ 5 (Brief, Pre-production, Production, Post-production, Distribution). Production milestones are
//    moved by members LOGGING work against the shoot (services/marketingShootSync.js), never by typing.
//  • A DELIVERED output is an asset attached to the shoot that is Approved or marked Final, or a PUBLISHED post linked to the shoot.
//    An asset's kind decides which planned output it meets: reel→reels, still→stills, film→films, carousel→carousels,
//    design/document→sales decks, a still tagged "story"→story frames. A post's format does the same: reel/trial reel/collab→reels,
//    feed post/image→stills, video→films, carousel→carousels, story→story frames. A post made from one of the shoot's delivered assets
//    is that asset going out, not another output, so it is counted once. Behind-the-scenes clips are footage, not outputs.
//  • Turnaround = days from the shoot date to the day the LAST output was delivered (an asset: the day it was approved or made final —
//    the day it was added for assets approved before that was recorded; a post: the day it went out) — only once every planned output
//    is delivered (or the shoot is Completed and has deliveries); until then there is none.
//  • Footage captured = the sizes typed on the shoot's assets (the team's own figure: no file is uploaded here).

export const MILESTONES = [
  { key: 'brief', label: 'Brief' },
  { key: 'pre_production', label: 'Pre-production' },
  { key: 'production', label: 'Production' },
  { key: 'post_production', label: 'Post-production' },
  { key: 'distribution', label: 'Distribution' },
];
export const OUTPUTS = [
  { key: 'reels', label: 'Reels' },
  { key: 'stills', label: 'Stills / Photos' },
  { key: 'films', label: 'Films / Long-form' },
  { key: 'carousels', label: 'Carousel' },
  { key: 'storyFrames', label: 'Stories' },
  { key: 'decks', label: 'Sales decks' },
];
export const STAGE_LABEL = { planned: 'Planned', pre_production: 'Pre-production', in_production: 'In Production', post_production: 'Post-production', completed: 'Completed', cancelled: 'Cancelled' };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const brandOk = (s, brand) => !brand || brand === 'all' || (s.brand ?? 'main') === brand;
const inRange = (day, from, to) => day >= from && day <= to;
const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/** Shoots that count in the range (and brand): by shoot date, not cancelled. */
export const shootsInRange = (shoots, { from, to, brand }) => shoots.filter((s) => s.status !== 'cancelled' && brandOk(s, brand) && inRange(s.shootDate, from, to));

export const progressOf = (shoot) => {
  const done = new Set((shoot.milestones ?? []).filter((m) => m.doneAt).map((m) => m.key));
  return Math.round((MILESTONES.filter((m) => done.has(m.key)).length / MILESTONES.length) * 100);
};

/** The milestone the shoot is at now: the first one not done (the last one when all are). */
export const currentMilestone = (shoot) => {
  const done = new Set((shoot.milestones ?? []).filter((m) => m.doneAt).map((m) => m.key));
  return (MILESTONES.find((m) => !done.has(m.key)) ?? MILESTONES[MILESTONES.length - 1]).key;
};

const plannedOf = (shoot) => Object.fromEntries(OUTPUTS.map((o) => [o.key, num(shoot.planned?.[o.key])]));
export const plannedTotal = (shoot) => OUTPUTS.reduce((s, o) => s + num(shoot.planned?.[o.key]), 0);

/** Which planned output an asset meets (null for footage and anything that is not an output). */
export const outputKeyOf = (asset) => {
  switch (asset.kind) {
    case 'reel': return 'reels';
    case 'film': return 'films';
    case 'carousel': return 'carousels';
    case 'design':
    case 'document': return 'decks';
    case 'still': return (asset.tags ?? []).includes('story') ? 'storyFrames' : 'stills';
    default: return null;
  }
};

export const isDelivered = (asset) => asset.stage === 'approved' || asset.isFinal === true;

const POST_KIND = { reel: 'reel', trial_reel: 'reel', collab: 'reel', post: 'still', image: 'still', story: 'still', video: 'film', carousel: 'carousel' };

/** A published post as a delivered output, shaped like an asset so every count below reads both; null when it is not one. */
export const postAsOutput = (post) => {
  if (!post || post.status !== 'published') return null;
  const kind = POST_KIND[post.contentType];
  if (!kind) return null;
  const at = post.publishedDate ?? post.scheduledDate ?? null;
  return { source: 'post', id: idOf(post), title: post.title ?? '', shootId: post.shootId ?? null, assetId: post.assetId ?? null, kind, tags: post.contentType === 'story' ? ['story'] : [], stage: 'approved', isFinal: true, approvedAt: at, createdAt: at, sizeMb: 0, durationSec: 0 };
};

/** One shoot's assets and the posts linked to it, as the list the counts read: the assets, then each published post that is not one of
 *  those delivered assets going out. */
export const mergeOutputs = (assets = [], posts = []) => {
  const counted = new Set(assets.filter(isDelivered).map(idOf));
  const extra = [];
  for (const p of posts) {
    const o = postAsOutput(p);
    if (o && !(o.assetId && counted.has(idOf(o.assetId)))) extra.push(o);
  }
  return [...assets, ...extra];
};

/** The day a delivered output counts as delivered. */
export const deliveredDay = (a) => istDay(a.approvedAt ?? a.createdAt);

/** Delivered outputs of one shoot, by kind. `assets` are that shoot's assets. */
export const deliveredOf = (assets) => {
  const out = Object.fromEntries(OUTPUTS.map((o) => [o.key, 0]));
  for (const a of assets) {
    if (!isDelivered(a)) continue;
    const k = outputKeyOf(a);
    if (k) out[k] += 1;
  }
  return out;
};
export const deliveredTotal = (assets) => Object.values(deliveredOf(assets)).reduce((s, n) => s + n, 0);

/** Turnaround in days, or null until it can be known (see the definition above). */
export const turnaroundDays = (shoot, assets) => {
  const delivered = assets.filter((a) => isDelivered(a) && outputKeyOf(a));
  if (!delivered.length) return null;
  const planned = plannedTotal(shoot);
  const met = planned > 0 ? deliveredTotal(assets) >= planned : shoot.status === 'completed';
  if (!met && shoot.status !== 'completed') return null;
  const last = delivered.map(deliveredDay).sort().pop();
  return Math.max(0, daysBetween(shoot.shootDate, last));
};

const groupBy = (list) => {
  const by = new Map();
  for (const a of list) {
    const k = idOf(a.shootId);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(a);
  }
  return by;
};

/** Group the assets — and the posts linked to shoots ([mergeOutputs]) — by shoot id. */
export const assetsByShoot = (assets, posts = []) => {
  const a = groupBy(assets);
  const p = groupBy(posts);
  const by = new Map();
  for (const k of new Set([...a.keys(), ...p.keys()])) by.set(k, mergeOutputs(a.get(k) ?? [], p.get(k) ?? []));
  return by;
};

/** The planner's KPI strip (range + brand) and the calendar's strip share these counts. */
export const shootCounts = (shoots, range, { today = istDay(), weekFrom, weekTo } = {}) => {
  const list = shootsInRange(shoots, range);
  const by = (st) => list.filter((s) => s.status === st).length;
  const wk = weekFrom && weekTo ? shoots.filter((s) => s.status !== 'cancelled' && brandOk(s, range.brand) && inRange(s.shootDate, weekFrom, weekTo)).length : 0;
  return {
    total: list.length,
    planned: by('planned') + by('pre_production'),
    inProduction: by('in_production'),
    postProduction: by('post_production'),
    completed: by('completed'),
    rescheduled: list.filter((s) => num(s.rescheduleCount) > 0).length,
    thisWeek: wk,
    today: list.filter((s) => s.shootDate === today).length,
  };
};

/** The donut: shoots by where they are (planned and pre-production together, as the document draws it). */
export const productionLoad = (shoots, range) => {
  const list = shootsInRange(shoots, range);
  const rows = [
    { key: 'pre_production', label: 'Pre-production', count: list.filter((s) => ['planned', 'pre_production'].includes(s.status)).length },
    { key: 'in_production', label: 'Production', count: list.filter((s) => s.status === 'in_production').length },
    { key: 'post_production', label: 'Post-production', count: list.filter((s) => s.status === 'post_production').length },
    { key: 'completed', label: 'Completed', count: list.filter((s) => s.status === 'completed').length },
  ];
  const total = list.length;
  return { total, rows: rows.map((r) => ({ ...r, pct: total ? Math.round((r.count / total) * 100) : 0 })) };
};

/**
 * Crew and resource availability for a day: for each role, how many people there are, how many are on leave, absent (marked so in
 * attendance), on one of the day's shoots, or on a client work (a makeup artist assigned to a booking that day), and how many are
 * left. Each person is counted once, in that order. `members` = [{ id, employeeId?, role, onLeave, absent?, onWork? }] — the Marketing
 * team and the makeup artists; `shootsOnDay` = the day's shoots (their crew names team members by memberId, artists by employeeId).
 */
export const crewAvailability = ({ members, shootsOnDay }) => {
  const onShootMember = new Set();
  const onShootEmployee = new Set();
  for (const s of shootsOnDay) {
    if (s.status === 'cancelled') continue;
    for (const c of s.crew ?? []) {
      if (c.memberId) onShootMember.add(idOf(c.memberId));
      if (c.employeeId) onShootEmployee.add(idOf(c.employeeId));
    }
  }
  const roles = new Map();
  for (const m of members) {
    const role = m.role || 'Team member';
    const r = roles.get(role) ?? { role, total: 0, booked: 0, onLeave: 0, absent: 0, onWork: 0, available: 0 };
    r.total += 1;
    if (m.onLeave) r.onLeave += 1;
    else if (m.absent) r.absent += 1;
    else if (onShootMember.has(idOf(m.id)) || (m.employeeId && onShootEmployee.has(idOf(m.employeeId)))) r.booked += 1;
    else if (m.onWork) r.onWork += 1;
    else r.available += 1;
    roles.set(role, r);
  }
  return [...roles.values()].sort((a, b) => b.total - a.total || a.role.localeCompare(b.role));
};

const DEAD_BOOKING = new Set(['cancelled', 'canceled', 'rejected', 'lost', 'postponed']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The event days of a booking: its selected dates, else the day its service starts (or its booking date). */
export const bookingDays = (b) => {
  const days = [...new Set((b?.selectedDates ?? []).map(String).filter((d) => DAY_RE.test(d)))];
  if (days.length) return days;
  const first = b?.serviceStart ?? b?.bookingDate;
  return first ? [istDay(first)] : [];
};

/**
 * The artists (lead or assistant — never the driver) working a client booking on [day]: those on the booking itself on its days, and
 * those on one of its packages on that package's days (the booking's days when the package has none). Cancelled, rejected, lost and
 * postponed bookings do not count. → Set of employee ids.
 */
export const artistsOnWorkDay = (bookings, day) => {
  const out = new Set();
  const add = (list) => {
    for (const st of list ?? []) if (st?.employeeId && st.roleType !== 'driver') out.add(idOf(st.employeeId));
  };
  for (const b of bookings) {
    if (DEAD_BOOKING.has(String(b.status ?? '').toLowerCase())) continue;
    const days = bookingDays(b);
    if (days.includes(day)) add(b.assignedStaff);
    for (const it of b.bookingItems ?? []) {
      const own = [...new Set((it?.selectedDates ?? []).map(String).filter((d) => DAY_RE.test(d)))];
      if ((own.length ? own : days).includes(day)) add(it.assignedStaff);
    }
  }
  return out;
};

/**
 * A shoot's content checklist (what the booking's Content card and the shoot report show): for each output that is planned or has
 * something delivered — how many are planned, delivered (assets and posts, each once), and how many posts of it went out.
 * `assets` = the shoot's assets; `posts` = the posts linked to the shoot.
 */
export const contentChecklist = (shoot, assets = [], posts = []) => {
  const planned = plannedOf(shoot);
  const delivered = deliveredOf(mergeOutputs(assets, posts));
  const posted = Object.fromEntries(OUTPUTS.map((o) => [o.key, 0]));
  for (const p of posts) {
    const o = postAsOutput(p);
    const k = o && outputKeyOf(o);
    if (k) posted[k] += 1;
  }
  return OUTPUTS.filter((o) => planned[o.key] > 0 || delivered[o.key] > 0 || posted[o.key] > 0).map((o) => ({ key: o.key, label: o.label, planned: planned[o.key], delivered: delivered[o.key], posted: posted[o.key], done: planned[o.key] > 0 ? delivered[o.key] >= planned[o.key] : delivered[o.key] > 0 }));
};

/** One row of the shoot report: planned and delivered outputs (and how many of those were posts), progress, turnaround. `assets` = the
 *  shoot's list from [assetsByShoot] / [mergeOutputs]. */
export const reportRow = (shoot, assets) => {
  const delivered = deliveredOf(assets);
  const deliveredPosts = deliveredOf(assets.filter((a) => a.source === 'post'));
  const planned = plannedOf(shoot);
  const dTotal = Object.values(delivered).reduce((s, n) => s + n, 0);
  const pTotal = Object.values(planned).reduce((s, n) => s + n, 0);
  return { planned, delivered, deliveredPosts, plannedTotal: pTotal, deliveredTotal: dTotal, progress: progressOf(shoot), turnaround: turnaroundDays(shoot, assets), onTrack: pTotal > 0 && dTotal >= pTotal };
};

/** The Shoot Reports KPI strip, with the change on the period before. `byShoot` = assets grouped by shoot id. */
export const reportKpis = (shoots, byShoot, range) => {
  const figures = (r) => {
    const list = shootsInRange(shoots, r);
    let delivered = 0;
    let sizeMb = 0;
    let sized = false;
    const turns = [];
    for (const s of list) {
      const assets = byShoot.get(idOf(s)) ?? [];
      delivered += deliveredTotal(assets);
      for (const a of assets) {
        if (num(a.sizeMb) > 0) {
          sizeMb += num(a.sizeMb);
          sized = true;
        }
      }
      const t = turnaroundDays(s, assets);
      if (t !== null) turns.push(t);
    }
    return { shoots: list.length, completed: list.filter((s) => s.status === 'completed').length, outputs: delivered, footageGb: sized ? round1(sizeMb / 1024) : null, turnaround: turns.length ? round1(turns.reduce((a, b) => a + b, 0) / turns.length) : null };
  };
  const now = figures({ ...range });
  const before = figures({ ...previousRange(range), brand: range.brand });
  return {
    ...now,
    change: {
      shoots: changePct(now.shoots, before.shoots),
      completed: changePct(now.completed, before.completed),
      outputs: changePct(now.outputs, before.outputs),
      footageGb: now.footageGb !== null && before.footageGb ? changePct(now.footageGb, before.footageGb) : null,
      // for turnaround a fall is the good direction; the sign is kept, the screen colours it
      turnaround: now.turnaround !== null && before.turnaround ? changePct(now.turnaround, before.turnaround) : null,
    },
  };
};

/** Planned against delivered outputs for each of the last [n] months ending at [endDay]'s month, and the average turnaround. */
export const monthlyReport = (shoots, byShoot, endDay, n = 5, brand = 'all') => {
  const [y, m] = endDay.split('-').map(Number);
  const months = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months.map((month) => {
    const list = shoots.filter((s) => s.status !== 'cancelled' && brandOk(s, brand) && s.shootDate.slice(0, 7) === month);
    let planned = 0;
    let delivered = 0;
    const turns = [];
    for (const s of list) {
      const a = byShoot.get(idOf(s)) ?? [];
      planned += plannedTotal(s);
      delivered += deliveredTotal(a);
      const t = turnaroundDays(s, a);
      if (t !== null) turns.push(t);
    }
    return { month, shoots: list.length, planned, delivered, turnaround: turns.length ? round1(turns.reduce((a, b) => a + b, 0) / turns.length) : null };
  });
};

/** Delivered outputs by kind over the shoots in the range, with each kind's share. */
export const outputDistribution = (shoots, byShoot, range) => {
  const totals = Object.fromEntries(OUTPUTS.map((o) => [o.key, 0]));
  for (const s of shootsInRange(shoots, range)) {
    const d = deliveredOf(byShoot.get(idOf(s)) ?? []);
    for (const k of Object.keys(totals)) totals[k] += d[k];
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  return { total, rows: OUTPUTS.filter((o) => totals[o.key] > 0).map((o) => ({ key: o.key, label: o.label, count: totals[o.key], pct: Math.round((totals[o.key] / total) * 100) })) };
};

/** A shoot is delayed when it is still open and a milestone planned for a day before [today] is not done. */
export const isDelayed = (shoot, today = istDay()) => {
  if (['completed', 'cancelled'].includes(shoot.status)) return false;
  return (shoot.milestones ?? []).some((m) => m.date && m.date < today && !m.doneAt);
};

/** Plain findings about one shoot, each only when the data supports it. */
export const takeaways = (shoot, assets) => {
  const out = [];
  const r = reportRow(shoot, assets);
  if (r.plannedTotal > 0 && r.deliveredTotal >= r.plannedTotal) out.push('All planned outputs have been delivered.');
  else if (r.plannedTotal > 0) out.push(`${r.deliveredTotal} of ${r.plannedTotal} planned outputs delivered so far.`);
  if (r.turnaround !== null) out.push(`Turnaround was ${r.turnaround} day${r.turnaround === 1 ? '' : 's'} from the shoot.`);
  const raw = assets.filter((a) => a.source !== 'post' && (['bts'].includes(a.kind) || a.stage === 'raw')).length;
  if (assets.length && raw === assets.length) out.push('Only raw footage is attached — nothing has been edited yet.');
  if (shoot.status === 'completed' && r.plannedTotal > 0 && r.deliveredTotal < r.plannedTotal) out.push(`Marked completed with ${r.plannedTotal - r.deliveredTotal} planned output${r.plannedTotal - r.deliveredTotal === 1 ? '' : 's'} not delivered.`);
  return out;
};

export { eachDay, addDays };
