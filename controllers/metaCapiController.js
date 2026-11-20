import MetaCapiEvent, { CAPI_EVENT_STATUSES } from '../models/MetaCapiEvent.js';
import MetaCapiState from '../models/MetaCapiState.js';
import MetaLeadEvent from '../models/MetaLeadEvent.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { CAPI_EVERY_MINUTES, CAPI_LEAD_EVENT_SOURCE, CAPI_MAX_AGE_DAYS, CAPI_STAGES, CAPI_WINDOW_DAYS, capiConfig } from '../utils/metaCapi.js';
import { MetaProblem } from '../services/metaGraph.js';
import { loadCapiState, runCapi } from '../services/metaCapi.js';

// /api/meta/capi — sending lead results back to Meta (behind login + the Marketing gate in routes/metaLeadRoutes.js). Switching it on
// or off is the Marketing Manager's / admin's; anyone on the team may see what was sent and press Send now while it is on. The token is
// never sent to the app: only whether each setting is set.

const STALE_MS = 20 * 60 * 1000;

const eventView = (e) => ({
  id: String(e._id),
  leadgenId: e.leadgenId,
  leadId: e.leadId ? String(e.leadId) : null,
  leadName: e.leadName || '',
  stage: e.stage,
  eventAt: new Date(e.eventTime * 1000),
  status: e.status,
  attempts: e.attempts ?? 0,
  retry: !!e.retry,
  nextTryAt: e.nextTryAt ?? null,
  problemCode: e.problemCode || '',
  problem: e.problem || '',
  sentAt: e.sentAt ?? null,
  test: !!e.test,
});

const runView = (r) =>
  r?.at
    ? { at: r.at, trigger: r.trigger || '', ok: !!r.ok, problemCode: r.problemCode || '', problem: r.problem || '', planned: r.planned ?? 0, sent: r.sent ?? 0, failed: r.failed ?? 0, skipped: r.skipped ?? 0, expired: r.expired ?? 0 }
    : null;

// @route GET /api/meta/capi/status
export const getCapiStatus = async (req, res) => {
  const cfg = capiConfig();
  const s = await loadCapiState();
  const since = new Date(Date.now() - 30 * 864e5);
  const [byStatus, sentByStage, followed, recent] = await Promise.all([
    MetaCapiEvent.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    MetaCapiEvent.aggregate([{ $match: { createdAt: { $gte: since }, status: 'sent' } }, { $group: { _id: '$stage', n: { $sum: 1 } } }]),
    MetaLeadEvent.countDocuments({ status: { $in: ['created', 'existing'] }, leadId: { $ne: null }, createdAt: { $gte: new Date(Date.now() - CAPI_WINDOW_DAYS * 864e5) } }),
    MetaCapiEvent.find().sort({ updatedAt: -1, _id: -1 }).limit(20).lean(),
  ]);
  const counts = Object.fromEntries(CAPI_EVENT_STATUSES.map((k) => [k, 0]));
  for (const g of byStatus) counts[g._id] = g.n;
  const stages = Object.fromEntries(CAPI_STAGES.map((k) => [k, 0]));
  for (const g of sentByStage) stages[g._id] = g.n;
  res.json({
    config: { ...cfg.has, ready: cfg.ready, version: cfg.version },
    settings: { enabled: !!s.enabled, enabledAt: s.enabledAt ?? null, updatedByName: s.updatedByName || '', everyMinutes: CAPI_EVERY_MINUTES, maxAgeDays: CAPI_MAX_AGE_DAYS, windowDays: CAPI_WINDOW_DAYS, crmName: CAPI_LEAD_EVENT_SOURCE },
    canManage: isManagerOrAdmin(req.user),
    running: !!s.running && !!s.runningSince && Date.now() - new Date(s.runningSince) < STALE_MS,
    lastRun: runView(s.lastRun),
    lastSentAt: s.lastSentAt ?? null,
    counts30: counts,
    sentByStage30: stages,
    followed,
    recent: recent.map(eventView),
  });
};

// @route PUT /api/meta/capi/settings {enabled}
export const updateCapiSettings = async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return res.status(403).json({ message: 'Only the Marketing Manager or Admin can switch sending results to Meta.' });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'Say whether results are sent to Meta.' });
  const s = await loadCapiState();
  const on = req.body.enabled;
  await MetaCapiState.updateOne(
    { key: 'capi' },
    { $set: { enabled: on, enabledAt: on ? (s.enabled ? s.enabledAt : new Date()) : s.enabledAt, updatedBy: req.user._id, updatedByName: req.user.name || '' } },
  );
  return getCapiStatus(req, res);
};

// @route POST /api/meta/capi/send — a run now (while switched on).
export const sendNow = async (req, res) => {
  try {
    const r = await runCapi({ trigger: 'manual' });
    if (r.off) return res.status(409).json({ message: 'Sending results to Meta is switched off.', code: 'off' });
    if (r.busy) return res.status(409).json({ message: 'A send is already running. Try again in a minute.', code: 'busy' });
    res.json({ run: runView(r) });
  } catch (err) {
    if (err instanceof MetaProblem) return res.status(409).json({ message: err.problem.text, code: err.problem.code });
    throw err;
  }
};

// @route GET /api/meta/capi/events?status=&page=&limit=
export const listCapiEvents = async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const status = String(req.query.status ?? 'all');
  if (status !== 'all' && !CAPI_EVENT_STATUSES.includes(status)) return res.status(400).json({ message: 'Unknown status.' });
  const filter = status === 'all' ? {} : { status };
  const [items, total] = await Promise.all([
    MetaCapiEvent.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    MetaCapiEvent.countDocuments(filter),
  ]);
  res.json({ items: items.map(eventView), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
};
