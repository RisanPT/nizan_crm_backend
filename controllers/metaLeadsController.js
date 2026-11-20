import crypto from 'node:crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import MetaLeadEvent, { META_EVENT_STATUSES } from '../models/MetaLeadEvent.js';
import MetaLeadSettings, { META_ASSIGN_MODES } from '../models/MetaLeadSettings.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { SALES_TARGET_ROLES } from '../utils/salesAchievement.js';
import { checkDays, metaConfig, readLeadgenChanges, verifyMetaSignature } from '../utils/metaLeads.js';
import {
  MetaProblem,
  checkMissedLeads,
  drainMetaLeads,
  knownPageIds,
  loadMetaSettings,
  receiveLeadgen,
  retryMetaLead,
  testMetaConnection,
} from '../services/metaLeads.js';

// ── the webhook (Meta calls it; no login — the signature is the check) ───────

const sameText = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// @route GET /api/meta/webhook — Meta's one-time check when the webhook is set up: echo its challenge when the verify token matches.
export const verifyWebhook = (req, res) => {
  const cfg = metaConfig();
  if (!cfg.has.verifyToken) return res.status(503).type('text/plain').send('Meta webhook is not set up on this server.');
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (req.query['hub.mode'] === 'subscribe' && sameText(req.query['hub.verify_token'], cfg.verifyToken) && /^[A-Za-z0-9_-]{1,200}$/.test(challenge)) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.status(403).type('text/plain').send('Forbidden');
};

// @route POST /api/meta/webhook — new Lead Ads leads. Signed by Meta with the app secret (X-Hub-Signature-256) over the RAW body, so
// this route reads the body itself (server.js mounts it before the JSON parser). Answers 200 once the lead ids are stored — Meta re-sends
// otherwise — and fetches the answers afterwards.
export const receiveWebhook = async (req, res) => {
  const cfg = metaConfig();
  if (!cfg.ready) return res.status(503).json({ message: 'Meta Lead Ads is not set up on this server.' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyMetaSignature(raw, req.get('x-hub-signature-256'), cfg.appSecret)) return res.status(401).json({ message: 'Bad signature.' });
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Not JSON.' });
  }
  try {
    await receiveLeadgen(readLeadgenChanges(body));
  } catch (err) {
    console.error('[Meta leads] storing a webhook failed:', err?.message ?? err);
    return res.status(500).json({ message: 'Could not store the lead; Meta will send it again.' });
  }
  res.status(200).json({ ok: true });
  setImmediate(() => drainMetaLeads().catch((err) => console.error('[Meta leads] taking in leads failed:', err?.message ?? err)));
};

// ── the Marketing team's screen (/api/meta, behind login + the Marketing gate in routes/metaLeadRoutes.js) ──

/** The people a Meta lead can be given to: active Sales logins. */
const salesPeople = async () =>
  User.find({ role: { $in: SALES_TARGET_ROLES }, active: { $ne: false } })
    .select('_id name role')
    .sort({ name: 1 })
    .lean();

const eventView = (e) => ({
  id: String(e._id),
  leadgenId: e.leadgenId,
  via: e.via,
  status: e.status,
  submittedAt: e.submittedAt,
  receivedAt: e.createdAt,
  doneAt: e.doneAt,
  attempts: e.attempts,
  retry: !!e.retry,
  nextTryAt: e.nextTryAt,
  problemCode: e.problemCode || '',
  problemText: e.problemText || '',
  leadName: e.leadName || '',
  email: e.status === 'failed' && e.problemCode === 'no_phone' ? e.email || '' : '',
  formName: e.formName || '',
  adName: e.adName || '',
  campaignName: e.campaignName || '',
  platform: e.platform || '',
  isOrganic: !!e.isOrganic,
  leadId: e.leadId ? String(e.leadId) : null,
  campaignId: e.campaignId ? String(e.campaignId) : null,
  assignedToName: e.assignedToName || '',
});

let lastStatusDrain = 0;

// @route GET /api/meta/status — is Meta set up (yes/no per setting, never the values), the team's choices, the last 30 days' counts.
export const getStatus = async (req, res) => {
  const cfg = metaConfig();
  // nothing runs on a timer when Meta was set up after the server started: opening this screen takes in what waits (once a minute at most)
  if (cfg.ready && Date.now() - lastStatusDrain > 60_000) {
    lastStatusDrain = Date.now();
    drainMetaLeads().catch(() => {});
  }
  const s = await loadMetaSettings();
  const since = new Date(Date.now() - 30 * 864e5);
  const [grouped, people, pageIds, last] = await Promise.all([
    MetaLeadEvent.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    salesPeople(),
    knownPageIds(cfg),
    MetaLeadEvent.findOne({ status: { $in: ['created', 'existing'] } }).sort({ doneAt: -1 }).select('doneAt').lean(),
  ]);
  const counts = Object.fromEntries(META_EVENT_STATUSES.map((k) => [k, 0]));
  for (const g of grouped) counts[g._id] = g.n;
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const rotate = (s.rotateUserIds ?? []).map(String);
  const rotateNames = rotate.length
    ? await User.find({ _id: { $in: rotate } }).select('_id name active').lean()
    : [];
  res.json({
    config: { ...cfg.has, ready: cfg.ready, version: cfg.version, webhookPath: '/api/meta/webhook' },
    canManage: isManagerOrAdmin(req.user),
    settings: {
      assignMode: s.assignMode,
      rotateUsers: rotate.map((id) => {
        const u = rotateNames.find((x) => String(x._id) === id);
        return { id, name: u?.name ?? 'Removed user', active: !!u && u.active !== false && byId.has(id) };
      }),
      updatedByName: s.updatedByName || '',
      updatedAt: s.updatedAt ?? null,
    },
    pageIds,
    lastCheck: s.lastCheck?.at ? s.lastCheck : null,
    lastLeadAt: last?.doneAt ?? null,
    counts30: { created: counts.created, existing: counts.existing, failed: counts.failed, waiting: counts.received + counts.working },
    assignees: people.map((p) => ({ id: String(p._id), name: p.name, role: p.role })),
  });
};

// @route GET /api/meta/events?status=&page=&limit= — what came in, newest first.
export const listEvents = async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const status = String(req.query.status ?? '');
  const filter = {};
  if (status === 'waiting') filter.status = { $in: ['received', 'working'] };
  else if (META_EVENT_STATUSES.includes(status)) filter.status = status;
  else if (status && status !== 'all') return res.status(400).json({ message: 'Unknown status.' });
  const [items, total] = await Promise.all([
    MetaLeadEvent.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    MetaLeadEvent.countDocuments(filter),
  ]);
  res.json({ items: items.map(eventView), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
};

// @route POST /api/meta/test — the token's owner and each known Page, read from Meta now.
export const testConnection = async (_req, res) => {
  res.json(await testMetaConnection());
};

// @route PUT /api/meta/settings {assignMode, rotateUserIds} — who gets a new Meta lead. Marketing Manager / admin only.
export const updateSettings = async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return res.status(403).json({ message: 'Only the Marketing Manager or Admin can change who gets Meta leads.' });
  const mode = String(req.body?.assignMode ?? '');
  if (!META_ASSIGN_MODES.includes(mode)) return res.status(400).json({ message: 'Choose who gets a new lead: nobody yet, or Sales in turn.' });
  const raw = Array.isArray(req.body?.rotateUserIds) ? req.body.rotateUserIds.map(String) : [];
  const ids = [...new Set(raw)];
  if (ids.length > 50) return res.status(400).json({ message: 'Choose at most 50 people.' });
  if (ids.some((id) => !mongoose.isValidObjectId(id))) return res.status(400).json({ message: 'Choose people from the list.' });
  if (mode === 'rotate') {
    if (!ids.length) return res.status(400).json({ message: 'Choose at least one Sales person to take turns.' });
    const allowed = new Set((await salesPeople()).map((p) => String(p._id)));
    const wrong = ids.filter((id) => !allowed.has(id));
    if (wrong.length) return res.status(400).json({ message: 'Only active Sales logins can take Meta leads.' });
  }
  await MetaLeadSettings.updateOne(
    { key: 'meta' },
    { $set: { assignMode: mode, rotateUserIds: mode === 'rotate' ? ids : [], updatedBy: req.user._id, updatedByName: req.user.name || '' } },
    { upsert: true },
  );
  return getStatus(req, res);
};

// @route POST /api/meta/events/:id/retry — fetch a failed lead again now.
export const retryEvent = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'No such lead.' });
  if (!metaConfig().ready) return res.status(409).json({ message: 'Meta Lead Ads is not set up on this server yet.' });
  const ok = await retryMetaLead(req.params.id);
  if (!ok) return res.status(409).json({ message: 'Only a lead that failed can be tried again.' });
  const e = await MetaLeadEvent.findById(req.params.id).lean();
  res.json(eventView(e));
};

// @route POST /api/meta/check {days} — read the last days' leads of every form from Meta and take in any the webhook missed.
export const checkMissed = async (req, res) => {
  const days = checkDays(req.body?.days);
  if (days == null) return res.status(400).json({ message: 'Choose 1 to 90 days (Meta keeps leads for 90 days).' });
  try {
    const r = await checkMissedLeads({ days, byName: req.user?.name || '' });
    if (r.busy) return res.status(409).json({ message: 'A check is already running. Try again in a minute.' });
    res.json(r);
  } catch (err) {
    if (err instanceof MetaProblem) return res.status(409).json({ message: err.problem.text, code: err.problem.code });
    throw err;
  }
};
