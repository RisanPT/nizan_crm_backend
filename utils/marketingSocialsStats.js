import { istDay, addDays, eachDay, previousRange, changePct } from './marketingTeamStats.js';
import { isOrganicInstagram, leadBrand } from './marketingLeadStages.js';

// What the Socials screens count — one definition of each number, used by every tab, so Overview, Performance and Reports agree.
// Items are ContentItem records (models/ContentItem.js); days are IST day strings 'YYYY-MM-DD'.
//
//  • "Posted" = an item in the Published stage. It counts on the day it went out (publishedDate; scheduledDate when that was
//    never filled in). Cancelled items count nowhere.
//  • The pipeline counts every non-cancelled item by stage: items still to go out on their scheduled day, items out on their
//    posted day, inside the range.
//  • Engagements = likes + comments + reposts + shares + saves. Engagement rate = engagements ÷ reach.
//  • Reach, impressions, likes… are typed from each platform's own insights onto the post (no platform API is connected), so the
//    sums are of what was entered — a post with nothing entered adds nothing.

export const STAGES = [
  { key: 'planned', label: 'Planned' },
  { key: 'producing', label: 'In Production' },
  { key: 'in_review', label: 'In Review' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'published', label: 'Published' },
];

const STAGE_OF = { idea: 'planned', planned: 'planned', 'in-progress': 'producing', 'in-review': 'in_review', scheduled: 'scheduled', published: 'published' };
export const stageOf = (status) => STAGE_OF[status] ?? null;

/** The format a content type counts under in the KPI strip and the activity tracker. */
export const formatOf = (contentType) => {
  switch (contentType) {
    case 'reel': return 'reels';
    case 'trial_reel': return 'trialReels';
    case 'story': return 'stories';
    case 'post':
    case 'carousel':
    case 'image': return 'feed';
    case 'collab': return 'collab';
    default: return 'other';
  }
};

export const PLATFORM_LABEL = { instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook', whatsapp: 'WhatsApp', website: 'Website', pinterest: 'Pinterest', snapchat: 'Snapchat', linkedin: 'LinkedIn', tiktok: 'TikTok', other: 'Other' };
export const BRAND_LABEL = { main: 'Main', kerala: 'Kerala' };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n) => Math.round(n * 10) / 10;
const inRange = (day, from, to) => day >= from && day <= to;
const brandOk = (it, brand) => !brand || brand === 'all' || (it.brand ?? 'main') === brand;

/** The day an item is counted on: out → when it went out; otherwise → its scheduled day. */
export const countedDay = (it) => (stageOf(it.status) === 'published' ? istDay(it.publishedDate ?? it.scheduledDate) : istDay(it.scheduledDate));

/** Items that are Published and went out inside the range (and brand). */
export const postedItems = (items, { from, to, brand }) => items.filter((it) => stageOf(it.status) === 'published' && brandOk(it, brand) && inRange(countedDay(it), from, to));

/** Non-cancelled items counted inside the range (and brand), whatever their stage. */
export const itemsInRange = (items, { from, to, brand }) => items.filter((it) => stageOf(it.status) && brandOk(it, brand) && inRange(countedDay(it), from, to));

export const emptyEngagement = () => ({ reach: 0, impressions: 0, views: 0, likes: 0, comments: 0, reposts: 0, shares: 0, saves: 0, linkClicks: 0 });

/** Sum of the typed metrics over a set of items. */
export const sumMetrics = (items) => {
  const t = emptyEngagement();
  for (const it of items) for (const k of Object.keys(t)) t[k] += num(it.metrics?.[k]);
  return t;
};

export const engagementsOf = (m) => num(m.likes) + num(m.comments) + num(m.reposts) + num(m.shares) + num(m.saves);
export const engagementRate = (m) => (num(m.reach) > 0 ? round1((engagementsOf(m) / num(m.reach)) * 100) : null);

/** The KPI strip: how many posts went out, by format — with the change against the period before. */
export const kpis = (items, range) => {
  const count = (r) => {
    const out = { total: 0, reels: 0, trialReels: 0, stories: 0, feed: 0, collab: 0, other: 0 };
    for (const it of postedItems(items, { ...r, brand: range.brand })) {
      out.total += 1;
      out[formatOf(it.contentType)] += 1;
    }
    return out;
  };
  const now = count(range);
  const before = count(previousRange(range));
  const change = Object.fromEntries(Object.keys(now).map((k) => [k, changePct(now[k], before[k])]));
  return { ...now, change };
};

/** The pipeline: each stage's count and share of everything in the range. */
export const pipeline = (items, range) => {
  const inScope = itemsInRange(items, range);
  const counts = Object.fromEntries(STAGES.map((s) => [s.key, 0]));
  for (const it of inScope) counts[stageOf(it.status)] += 1;
  const total = inScope.length;
  return { total, stages: STAGES.map((s) => ({ key: s.key, label: s.label, count: counts[s.key], pct: total ? Math.round((counts[s.key] / total) * 100) : 0 })) };
};

/** Posts per platform and brand ("Instagram (Main)") with a daily sparkline and the change on the period before. */
export const platformDistribution = (items, range) => {
  const days = eachDay(range.from, range.to);
  const prev = previousRange(range);
  const key = (it) => `${it.platform ?? 'other'}|${it.brand ?? 'main'}`;
  const rows = new Map();
  for (const it of postedItems(items, range)) {
    const k = key(it);
    if (!rows.has(k)) rows.set(k, { platform: it.platform ?? 'other', brand: it.brand ?? 'main', count: 0, byDay: new Map() });
    const r = rows.get(k);
    r.count += 1;
    r.byDay.set(countedDay(it), (r.byDay.get(countedDay(it)) ?? 0) + 1);
  }
  const before = new Map();
  for (const it of postedItems(items, { ...prev, brand: range.brand })) before.set(key(it), (before.get(key(it)) ?? 0) + 1);
  return [...rows.values()]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      platform: r.platform,
      brand: r.brand,
      label: r.platform === 'instagram' ? `Instagram (${BRAND_LABEL[r.brand]})` : (PLATFORM_LABEL[r.platform] ?? r.platform),
      count: r.count,
      spark: days.map((d) => r.byDay.get(d) ?? 0),
      change: changePct(r.count, before.get(`${r.platform}|${r.brand}`) ?? 0),
    }));
};

/** Likes, comments, reposts, shares, saves over the posts that went out in the range, with the change on the period before. */
export const engagementOverview = (items, range) => {
  const now = sumMetrics(postedItems(items, range));
  const before = sumMetrics(postedItems(items, { ...previousRange(range), brand: range.brand }));
  const change = Object.fromEntries(Object.keys(now).map((k) => [k, changePct(now[k], before[k])]));
  return { ...now, engagements: engagementsOf(now), engagementRate: engagementRate(now), change, engagementsChange: changePct(engagementsOf(now), engagementsOf(before)) };
};

/** Reach and impressions for each day (the day the post went out). */
export const reachTrend = (items, range) => {
  const by = new Map();
  for (const it of postedItems(items, range)) {
    const d = countedDay(it);
    const e = by.get(d) ?? { reach: 0, impressions: 0 };
    e.reach += num(it.metrics?.reach);
    e.impressions += num(it.metrics?.impressions);
    by.set(d, e);
  }
  return eachDay(range.from, range.to).map((day) => ({ day, reach: by.get(day)?.reach ?? 0, impressions: by.get(day)?.impressions ?? 0 }));
};

/** The best posts of the range, by views (reach when a post has no views typed). */
export const topContent = (items, range, n = 5) =>
  postedItems(items, range)
    .map((it) => ({ id: String(it._id ?? it.id ?? ''), title: it.title, platform: it.platform, brand: it.brand ?? 'main', contentType: it.contentType, thumbUrl: it.thumbUrl ?? '', permalink: it.permalink ?? '', views: num(it.metrics?.views) || num(it.metrics?.reach), engagements: engagementsOf(it.metrics ?? {}) }))
    .filter((r) => r.views > 0 || r.engagements > 0)
    .sort((a, b) => b.views - a.views || b.engagements - a.engagements)
    .slice(0, n);

/** One row per platform: posts, reach, impressions, engagements and engagement rate — with the change in posts, reach and engagements
 *  against the period before (null when there is nothing before to compare with). */
export const platformPerformance = (items, range) => {
  const group = (list) => {
    const by = new Map();
    for (const it of list) {
      const p = it.platform ?? 'other';
      if (!by.has(p)) by.set(p, []);
      by.get(p).push(it);
    }
    return by;
  };
  const now = group(postedItems(items, range));
  const before = group(postedItems(items, { ...previousRange(range), brand: range.brand }));
  return [...now.entries()]
    .map(([platform, list]) => {
      const m = sumMetrics(list);
      const b = sumMetrics(before.get(platform) ?? []);
      const postsBefore = (before.get(platform) ?? []).length;
      return {
        platform,
        label: PLATFORM_LABEL[platform] ?? platform,
        posts: list.length,
        reach: m.reach,
        impressions: m.impressions,
        engagements: engagementsOf(m),
        er: engagementRate(m),
        change: { posts: changePct(list.length, postsBefore), reach: changePct(m.reach, b.reach), engagements: changePct(engagementsOf(m), engagementsOf(b)) },
      };
    })
    .sort((a, b) => b.reach - a.reach || b.posts - a.posts);
};

/** The Content Activity Tracker: for each metric the team logs under Socials, the target for the period and what was logged. */
export const trackerRows = ({ metrics = [], targets = new Map(), logged = new Map() }) =>
  metrics.map((m) => {
    const target = targets.has(m.id) ? num(targets.get(m.id)) : null;
    const completed = num(logged.get(m.id));
    return { metricId: m.id, name: m.name, target, completed, progress: target ? Math.round((completed / target) * 100) : null };
  });

/** Month-by-month reach / impressions / engagements for the last [n] months ending at [endDay]'s month. */
export const monthlyTrend = (items, endDay, n = 6, brand = 'all') => {
  const [y, m] = endDay.split('-').map(Number);
  const months = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const out = new Map(months.map((mo) => [mo, { month: mo, reach: 0, impressions: 0, engagements: 0, posts: 0 }]));
  for (const it of items) {
    if (stageOf(it.status) !== 'published' || !brandOk(it, brand)) continue;
    const e = out.get(countedDay(it).slice(0, 7));
    if (!e) continue;
    e.reach += num(it.metrics?.reach);
    e.impressions += num(it.metrics?.impressions);
    e.engagements += engagementsOf(it.metrics ?? {});
    e.posts += 1;
  }
  return months.map((mo) => out.get(mo));
};

/** Overall growth for the summary: the average of the change in reach, impressions and engagements (those with a base). */
export const overallGrowth = (cur, before) => {
  const parts = ['reach', 'impressions'].map((k) => changePct(num(cur[k]), num(before[k]))).concat(changePct(engagementsOf(cur), engagementsOf(before))).filter((v) => v !== null);
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
};

/** Plain-language findings, each only when the data supports it. */
export const insights = (items, range, now = new Date()) => {
  const out = [];
  const posted = postedItems(items, range);
  const withMetrics = posted.filter((it) => engagementsOf(it.metrics ?? {}) > 0);
  const avg = (list) => (list.length ? list.reduce((s, it) => s + engagementsOf(it.metrics ?? {}), 0) / list.length : 0);
  const reels = withMetrics.filter((it) => ['reel', 'trial_reel'].includes(it.contentType));
  const stills = withMetrics.filter((it) => ['post', 'carousel', 'image'].includes(it.contentType));
  if (reels.length >= 2 && stills.length >= 2 && avg(stills) > 0) out.push(`Reels earned ${round1(avg(reels) / avg(stills))}× the engagement of static posts (${reels.length} reels, ${stills.length} static).`);
  if (withMetrics.length >= 4) {
    const byHour = new Map();
    for (const it of withMetrics) {
      const h = new Date(new Date(it.publishedDate ?? it.scheduledDate).getTime() + 5.5 * 3600 * 1000).getUTCHours();
      const e = byHour.get(h) ?? { sum: 0, n: 0 };
      e.sum += engagementsOf(it.metrics);
      e.n += 1;
      byHour.set(h, e);
    }
    const best = [...byHour.entries()].filter(([, e]) => e.n >= 2).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)[0];
    if (best) out.push(`Best posting hour: ${best[0] % 12 || 12}:00 ${best[0] < 12 ? 'AM' : 'PM'} (highest average engagement).`);
  }
  const er = engagementRate(sumMetrics(posted));
  const erBefore = engagementRate(sumMetrics(postedItems(items, { ...previousRange(range), brand: range.brand })));
  if (er !== null && erBefore !== null) out.push(`Engagement rate is ${er}%, ${er >= erBefore ? 'up' : 'down'} ${round1(Math.abs(er - erBefore))} pp on the period before.`);
  const today = istDay(now);
  const overdue = items.filter((it) => brandOk(it, range.brand) && ['planned', 'idea', 'in-progress', 'in-review', 'scheduled'].includes(it.status) && istDay(it.scheduledDate) < today).length;
  if (overdue > 0) out.push(`${overdue} item${overdue === 1 ? ' is' : 's are'} past the scheduled day and not yet published.`);
  return out;
};


// ── leads and targets ─────────────────────────────────────────────────────────

// An organic Instagram lead and a lead's brand are defined once, in utils/marketingLeadStages.js (shared with the Lead Report).
export { isOrganicInstagram, leadBrand };

/** Organic Instagram leads inside the range, split by brand, with the period before. Leads are { source, region, district, day }. */
export const organicLeads = (leads, range) => {
  const count = (r) => {
    const out = { total: 0, main: 0, kerala: 0 };
    for (const l of leads) {
      if (!isOrganicInstagram(l.source) || !inRange(l.day, r.from, r.to)) continue;
      const b = leadBrand(l);
      if (range.brand !== 'all' && range.brand && b !== range.brand) continue;
      out.total += 1;
      out[b] += 1;
    }
    return out;
  };
  const now = count(range);
  return { ...now, change: changePct(now.total, count(previousRange(range)).total) };
};

/**
 * The target for one metric in one week: the latest row set for that week or an earlier one (a week with none inherits).
 * A brand's own row wins over the "all brands" row; "all brands" with no row of its own is the sum of the brands' rows.
 * Rows are { brand, period, metricId, target }.
 */
export const weekTarget = (rows, { brand = 'all', week, metricId }) => {
  const latest = (b) => rows.filter((r) => r.brand === b && String(r.metricId) === String(metricId) && r.period <= week).sort((a, c) => (a.period < c.period ? 1 : -1))[0];
  if (brand !== 'all') return (latest(brand) ?? latest('all'))?.target ?? null;
  const all = latest('all');
  if (all) return all.target;
  const parts = ['main', 'kerala'].map(latest).filter(Boolean);
  return parts.length ? parts.reduce((s, r) => s + r.target, 0) : null;
};

/**
 * The target over a range, pro-rated by days: each week's target counts for the share of that week's seven days the range covers — a
 * whole week is its target, one day is a seventh of it, a month adds up its weeks (and the parts of the weeks at its ends). Rounded to
 * one decimal; null when no week of the range has a target.
 */
export const rangeTarget = (rows, { brand = 'all', from, to, metricId }) => {
  const dow = new Date(Date.parse(`${from}T00:00:00Z`)).getUTCDay();
  let week = addDays(from, -((dow + 6) % 7));
  let total = 0;
  let any = false;
  for (let guard = 0; week <= to && guard < 60; guard += 1) {
    const t = weekTarget(rows, { brand, week, metricId });
    if (t !== null) {
      const sunday = addDays(week, 6);
      const a = from > week ? from : week;
      const z = to < sunday ? to : sunday;
      total += (t * eachDay(a, z).length) / 7;
      any = true;
    }
    week = addDays(week, 7);
  }
  return any ? round1(total) : null;
};

/**
 * What to do next — plain rules on the period's figures, each only when the data supports it, most pressing first. `opts.followers`
 * = the followers change in % (or null); `opts.upcoming` = how many posts are planned for the next 7 days; `opts.now` = the moment
 * "overdue" and "next 7 days" are measured from.
 */
export const nextActions = (items, range, { now = new Date(), followers = null, upcoming = undefined } = {}) => {
  const out = [];
  const today = istDay(now);
  const mine = items.filter((it) => brandOk(it, range.brand));
  const overdue = mine.filter((it) => ['planned', 'idea', 'in-progress', 'in-review', 'scheduled'].includes(it.status) && istDay(it.scheduledDate) < today).length;
  if (overdue > 0) out.push(`Publish or reschedule the ${overdue} post${overdue === 1 ? '' : 's'} past ${overdue === 1 ? 'its' : 'their'} scheduled day.`);
  const inReview = mine.filter((it) => it.status === 'in-review').length;
  if (inReview > 0) out.push(`Review the ${inReview} post${inReview === 1 ? '' : 's'} waiting for approval, so ${inReview === 1 ? 'it can' : 'they can'} be scheduled.`);
  const posted = postedItems(items, range);
  const noNumbers = posted.filter((it) => num(it.metrics?.reach) === 0 && num(it.metrics?.views) === 0 && engagementsOf(it.metrics ?? {}) === 0).length;
  if (noNumbers > 0) out.push(`Type the numbers on the ${noNumbers} post${noNumbers === 1 ? '' : 's'} that went out without any — they are missing from these figures.`);
  // what is planned for the next seven days: given by the caller (it needs posts beyond the period), else counted from [items]
  const nextWeek = { from: addDays(today, 1), to: addDays(today, 7) };
  const planned = upcoming ?? mine.filter((it) => ['planned', 'idea', 'in-progress', 'in-review', 'scheduled'].includes(it.status) && inRange(istDay(it.scheduledDate), nextWeek.from, nextWeek.to)).length;
  if (range.to >= today && planned === 0) out.push('Nothing is planned for the next 7 days — plan the next posts on the calendar.');
  const withMetrics = posted.filter((it) => engagementsOf(it.metrics ?? {}) > 0);
  const avg = (list) => (list.length ? list.reduce((s, it) => s + engagementsOf(it.metrics ?? {}), 0) / list.length : 0);
  const reels = withMetrics.filter((it) => ['reel', 'trial_reel'].includes(it.contentType));
  const stills = withMetrics.filter((it) => ['post', 'carousel', 'image'].includes(it.contentType));
  if (reels.length >= 2 && stills.length >= 2 && avg(stills) > 0) {
    const x = avg(reels) / avg(stills);
    if (x >= 1.5) out.push(`Reels are earning ${round1(x)}× the engagement of static posts — plan more reels.`);
    else if (x <= 1 / 1.5) out.push(`Static posts are earning ${round1(1 / x)}× the engagement of reels — keep them in the plan.`);
  }
  for (const p of platformPerformance(items, range)) {
    if (p.change.reach !== null && p.change.reach <= -20) out.push(`Reach on ${p.label} fell ${Math.abs(p.change.reach)}% — look at what went out there and when.`);
  }
  const er = engagementRate(sumMetrics(posted));
  const erBefore = engagementRate(sumMetrics(postedItems(items, { ...previousRange(range), brand: range.brand })));
  if (er !== null && erBefore !== null && erBefore - er >= 1) out.push(`Engagement rate fell from ${erBefore}% to ${er}% — try the formats and posting times that did best.`);
  if (followers !== null && followers < 0) out.push(`Followers fell ${Math.abs(followers)}% — check the accounts' figures were typed for both periods.`);
  return out;
};

export { addDays };
