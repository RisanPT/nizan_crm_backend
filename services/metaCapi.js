// Sending lead results back to Meta (Conversions API for CRM). The rules are in utils/metaCapi.js.
//
//  • planCapiEvents: for every Lead Ads lead of the last 35 days, the stages its CRM lead has reached (stagesFor) that are not in the
//    outbox yet are added (MetaCapiEvent, unique per Meta lead and stage — a stage is never sent twice). One older than Meta's 7 days
//    when first seen is kept as skipped.
//  • runCapi: plans, marks what grew too old as expired, then sends — new events in requests of 50 (earlier stages first), and a failed
//    event alone (one bad event drops its whole request, so it must not hold the others back), tried again later (10 min, 20, 40… up to
//    6 tries). One run at a time; nothing at all while the Marketing Manager / admin has not switched it on.
//  • startMetaCapi: when the server is set up, a run every hour (Meta asks for at least one upload a day).
// The lead's phone and e-mail leave the server only hashed; nothing here returns or logs the token.
import Lead from '../models/Lead.js';
import MetaLeadEvent from '../models/MetaLeadEvent.js';
import MetaCapiEvent from '../models/MetaCapiEvent.js';
import MetaCapiState from '../models/MetaCapiState.js';
import { MetaProblem, graphPost } from './metaGraph.js';
import {
  CAPI_BATCH,
  CAPI_EVERY_MINUTES,
  CAPI_MAX_AGE_DAYS,
  CAPI_NOT_CONFIGURED,
  CAPI_STAGES,
  CAPI_WINDOW_DAYS,
  capiConfig,
  capiEvent,
  capiNextTry,
  requestBody,
  stageTimes,
  stagesFor,
  tooOld,
} from '../utils/metaCapi.js';

const RUN_STALE_MS = 20 * 60 * 1000;
const MAX_NEW_PER_RUN = 2000;
const MAX_RETRIES_PER_RUN = 200;
const TOO_OLD_SEEN = 'It was already older than Meta\'s 7 days when the CRM first saw it, so it was not sent.';
const TOO_OLD_WAITED = 'It grew older than Meta\'s 7 days before Meta took it.';

export const loadCapiState = () =>
  MetaCapiState.findOneAndUpdate({ key: 'capi' }, { $setOnInsert: { key: 'capi' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

const claim = async () => {
  await loadCapiState();
  const now = new Date();
  return MetaCapiState.findOneAndUpdate(
    { key: 'capi', $or: [{ running: false }, { runningSince: null }, { runningSince: { $lt: new Date(now.getTime() - RUN_STALE_MS) } }] },
    { $set: { running: true, runningSince: now } },
    { new: true },
  ).lean();
};

/**
 * Add to the outbox every stage Meta should have and does not. A Meta lead whose number was already a client (booked BEFORE the form)
 * counts only as a Lead: that booking is not this form's result. → { planned, skipped }
 */
export const planCapiEvents = async (now = new Date()) => {
  const since = new Date(now.getTime() - CAPI_WINDOW_DAYS * 864e5);
  const metaLeads = await MetaLeadEvent.find({ status: { $in: ['created', 'existing'] }, leadId: { $ne: null }, createdAt: { $gte: since } })
    .select('leadgenId leadId leadName submittedAt createdAt')
    .lean();
  if (!metaLeads.length) return { planned: 0, skipped: 0 };
  const leads = await Lead.find({ _id: { $in: [...new Set(metaLeads.map((e) => String(e.leadId)))] } }).select('name status bookingId bookedDate updatedAt').lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));
  const have = await MetaCapiEvent.find({ leadgenId: { $in: metaLeads.map((e) => e.leadgenId) } }).select('leadgenId stage').lean();
  const known = new Set(have.map((h) => `${h.leadgenId}|${h.stage}`));
  const docs = [];
  for (const e of metaLeads) {
    const lead = byId.get(String(e.leadId));
    if (!lead) continue;
    const submittedAt = e.submittedAt ?? e.createdAt;
    const bookedBefore = lead.bookedDate && submittedAt && new Date(lead.bookedDate) < new Date(submittedAt);
    const stages = bookedBefore ? ['Lead'] : stagesFor(lead.status, { booked: !!lead.bookingId });
    const times = stageTimes(stages, { submittedAt, bookedAt: lead.bookedDate, updatedAt: lead.updatedAt }, now);
    for (const [i, stage] of stages.entries()) {
      if (known.has(`${e.leadgenId}|${stage}`)) continue;
      const eventTime = times[i];
      const old = tooOld(eventTime, now);
      docs.push({
        leadgenId: e.leadgenId,
        leadId: lead._id,
        leadName: (lead.name || e.leadName || '').slice(0, 120),
        stage,
        eventTime,
        status: old ? 'skipped' : 'pending',
        retry: !old,
        problemCode: old ? 'too_old' : '',
        problem: old ? TOO_OLD_SEEN : '',
      });
    }
  }
  if (docs.length) {
    try {
      await MetaCapiEvent.insertMany(docs, { ordered: false });
    } catch (err) {
      if (err?.code !== 11000 && !err?.writeErrors) throw err; // a stage planned by another run at the same moment: already there
    }
  }
  return { planned: docs.filter((d) => d.status === 'pending').length, skipped: docs.filter((d) => d.status === 'skipped').length };
};

const expireOld = async (now) => {
  const cutoff = Math.floor((now.getTime() - CAPI_MAX_AGE_DAYS * 864e5 + 3600 * 1000) / 1000);
  const r = await MetaCapiEvent.updateMany(
    { status: { $in: ['pending', 'failed'] }, eventTime: { $lt: cutoff } },
    { $set: { status: 'expired', retry: false, nextTryAt: null, problemCode: 'too_old', problem: TOO_OLD_WAITED } },
  );
  return r.modifiedCount ?? 0;
};

const order = (a, b) => a.eventTime - b.eventTime || CAPI_STAGES.indexOf(a.stage) - CAPI_STAGES.indexOf(b.stage);

/** One request to Meta. → { sent, failed, problem } */
const sendRequest = async (cfg, events, leadsById, now) => {
  const payload = events.map((ev) => {
    const l = leadsById.get(String(ev.leadId));
    return capiEvent({ stage: ev.stage, eventTime: ev.eventTime, leadgenId: ev.leadgenId, email: l?.email, phone: l?.phone });
  });
  try {
    const r = await graphPost(cfg, `${cfg.datasetId}/events`, requestBody(payload, cfg.testCode), cfg.token, { proof: cfg.proof });
    await MetaCapiEvent.updateMany(
      { _id: { $in: events.map((e) => e._id) } },
      { $set: { status: 'sent', sentAt: now, fbtraceId: String(r?.fbtrace_id ?? '').slice(0, 80), problemCode: '', problem: '', retry: false, nextTryAt: null, test: !!cfg.testCode }, $inc: { attempts: 1 } },
    );
    return { sent: events.length, failed: 0, problem: null };
  } catch (err) {
    let p = err instanceof MetaProblem ? err.problem : { code: 'refused', retry: true, text: 'Meta did not take the events.' };
    // Lead Ads' wording names a lead's rights and the main token; here it is the dataset, and maybe Events Manager's own token
    if (p.code === 'permission') p = { ...p, text: 'The token may not send to this dataset. Give the system user the dataset in Events Manager, or use the token Events Manager makes (META_CAPI_TOKEN).' };
    if (p.code === 'token' && !cfg.proof) p = { ...p, text: 'Meta refused the Conversions API token (expired, changed or withdrawn). Make a new one in Events Manager and put it in META_CAPI_TOKEN on the server.' };
    if (!(err instanceof MetaProblem)) console.error('[Meta results] sending failed:', err?.message ?? err);
    // a passing trouble (Meta busy or down, the network, the token or a right being fixed) is tried again; a request of several that Meta
    // refused is tried again event by event (the bad one must not hold the others back); one event refused on its own is not
    const passing = ['rate_limit', 'meta_down', 'unreachable', 'token', 'permission'].includes(p.code);
    for (const ev of events) {
      const attempts = (ev.attempts ?? 0) + 1;
      const next = capiNextTry(attempts, now, passing || events.length > 1);
      await MetaCapiEvent.updateOne({ _id: ev._id }, { $set: { status: 'failed', problemCode: p.code, problem: p.text, retry: !!next, nextTryAt: next }, $inc: { attempts: 1 } });
    }
    return { sent: 0, failed: events.length, problem: p };
  }
};

/**
 * One run: plan, expire, send. → the run's summary, { off: true } when switched off, { busy: true } when a run is going.
 * Throws a MetaProblem only when the server is not set up.
 */
export const runCapi = async ({ trigger = 'auto', now = new Date() } = {}) => {
  const cfg = capiConfig();
  if (!cfg.ready) throw new MetaProblem(CAPI_NOT_CONFIGURED);
  const state = await loadCapiState();
  if (!state.enabled) return { off: true };
  if (!(await claim())) return { busy: true };
  const lastRun = { at: now, trigger, ok: false, problemCode: '', problem: '', planned: 0, sent: 0, failed: 0, skipped: 0, expired: 0 };
  try {
    const plan = await planCapiEvents(now);
    lastRun.planned = plan.planned;
    lastRun.skipped = plan.skipped;
    lastRun.expired = await expireOld(now);
    const fresh = (await MetaCapiEvent.find({ status: 'pending' }).sort({ eventTime: 1 }).limit(MAX_NEW_PER_RUN).lean()).sort(order);
    const due = (await MetaCapiEvent.find({ status: 'failed', retry: true, nextTryAt: { $ne: null, $lte: now } }).sort({ nextTryAt: 1 }).limit(MAX_RETRIES_PER_RUN).lean()).sort(order);
    const leadIds = [...new Set([...fresh, ...due].map((e) => String(e.leadId)))];
    const leadsById = new Map((leadIds.length ? await Lead.find({ _id: { $in: leadIds } }).select('email phone').lean() : []).map((l) => [String(l._id), l]));
    let problem = null;
    const stopAll = (p) => p && ['token', 'permission', 'not_configured'].includes(p.code); // the next request would fail the same way
    for (let i = 0; i < fresh.length; i += CAPI_BATCH) {
      const r = await sendRequest(cfg, fresh.slice(i, i + CAPI_BATCH), leadsById, now);
      lastRun.sent += r.sent;
      lastRun.failed += r.failed;
      if (r.problem) problem = r.problem;
      if (stopAll(r.problem)) break;
    }
    if (!stopAll(problem)) {
      for (const ev of due) {
        const r = await sendRequest(cfg, [ev], leadsById, now);
        lastRun.sent += r.sent;
        lastRun.failed += r.failed;
        if (r.problem) problem = r.problem;
        if (stopAll(r.problem)) break;
      }
    }
    lastRun.ok = !problem;
    if (problem) Object.assign(lastRun, { problemCode: problem.code, problem: problem.text });
    await MetaCapiState.updateOne({ key: 'capi' }, { $set: { lastRun, running: false, runningSince: null, ...(lastRun.sent ? { lastSentAt: now } : {}) } });
    return lastRun;
  } catch (err) {
    console.error('[Meta results] run failed:', err?.message ?? err);
    Object.assign(lastRun, { ok: false, problemCode: 'save_failed', problem: 'The CRM could not prepare the events. It will try again.' });
    await MetaCapiState.updateOne({ key: 'capi' }, { $set: { lastRun, running: false, runningSince: null } });
    return lastRun;
  }
};

let timer = null;
/** Called once at server start: when the server is set up, a run every hour (it does nothing while switched off). */
export const startMetaCapi = () => {
  if (timer || !capiConfig().ready) return;
  const tick = () => runCapi({ trigger: 'auto' }).catch((err) => console.error('[Meta results] automatic run failed:', err?.message ?? err));
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  timer = setInterval(tick, CAPI_EVERY_MINUTES * 60 * 1000);
  timer.unref?.();
};
