import mongoose from 'mongoose';
import DecisionRequest from '../models/DecisionRequest.js';
import DecisionPolicy from '../models/DecisionPolicy.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import { LEADERSHIP_ROLES, isLeadership, leadershipTitle } from '../utils/leadership.js';
import { notify, getUserIdsByRoles, NOTIFICATION_TYPES } from '../utils/notify.js';
import { logChange } from '../utils/audit.js';
import { money } from '../utils/projectCost.js';
import {
  KINDS, KIND_LABELS, OPEN_STATUSES, isOpenStatus, validateDecision, validatePolicyInput, policyIsOn, policySummary, limitFor,
  nextStatus, isMaterialChange, shapeRequest, conflictBody, needsLeadership,
} from '../utils/decisionRules.js';
import { HANDLERS } from './decisionHandlers.js';

// The workflow behind the CEO / Executive Director's desk (see utils/decisionRules.js for the rules, models/DecisionRequest.js for
// the data). Summary:
//   escalate()   the team has checked an item and it is above the limit → hold it, ask the leaders
//   decide()     a leader approves / rejects / defers; first decision wins; the source is changed only AFTER the decision is recorded
//   supersedeFor / withdrawFor   the item was edited / deleted / decided elsewhere while it waited
//   syncOpen()   repairs what a crash could leave behind (and mirrors proposals made before this existed)
// No transactions are assumed: every step is a conditional update, and applying a decision may safely be run twice.

export class DecisionError extends Error {
  constructor(status, body) {
    super(body?.message ?? 'Decision error');
    this.status = status;
    this.body = body;
  }
}

const idStr = (v) => (v == null ? '' : String(v._id ?? v));
export const personOf = (user) => (user ? { id: user._id ?? null, name: user.name ?? '', role: String(user.role ?? '').toLowerCase() } : null);
const clip = (s, n = 300) => String(s ?? '').trim().slice(0, n);

// ── the policy ───────────────────────────────────────────────────────────────

export const getPolicy = async () => {
  try {
    return await DecisionPolicy.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (e) {
    if (e?.code === 11000) return DecisionPolicy.findOne({ key: 'default' }).lean(); // two first requests raced: the other one made it
    throw e;
  }
};

export const policyView = (policy) => ({
  spendLimits: {
    expense: limitFor(policy, 'spend_expense'),
    payout: limitFor(policy, 'spend_payout'),
    projectBudget: limitFor(policy, 'project_budget'),
  },
  hiringPlansNeedLeadership: policy?.hiringPlansNeedLeadership === true,
  on: policyIsOn(policy),
  summary: policySummary(policy),
  updatedAt: policy?.updatedAt ?? null,
  updatedByName: policy?.updatedByName ?? '',
  history: (policy?.history ?? []).slice(-10).reverse().map((h) => ({ at: h.at, byName: h.byName, before: h.before, after: h.after })),
});

/// Is there a CEO / Executive Director who can actually decide? Without one nothing is held (fail open) and the rules cannot be switched on.
export const hasLeadership = async () => !!(await User.exists({ role: { $in: LEADERSHIP_ROLES }, active: { $ne: false } }));

const leaderIds = () => getUserIdsByRoles(LEADERSHIP_ROLES);

export const savePolicy = async ({ body, user }) => {
  const current = await getPolicy();
  const checked = validatePolicyInput(body, current);
  if (!checked.ok) throw new DecisionError(400, { code: checked.code, field: checked.field, message: checked.message });
  const next = checked.value;
  const before = { spendLimits: policyView(current).spendLimits, hiringPlansNeedLeadership: current.hiringPlansNeedLeadership === true };
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  if (!changed) return getPolicy();
  if (policyIsOn(next) && !(await hasLeadership())) {
    throw new DecisionError(409, {
      code: 'NO_LEADERSHIP_ACCOUNT',
      message: 'There is no CEO or Executive Director login yet, so nothing could be decided. Create one first, then set these rules.',
    });
  }
  const saved = await DecisionPolicy.findOneAndUpdate(
    { key: 'default' },
    {
      $set: { spendLimits: next.spendLimits, hiringPlansNeedLeadership: next.hiringPlansNeedLeadership, updatedBy: user._id, updatedByName: user.name ?? '' },
      $push: { history: { at: new Date(), by: user._id, byName: user.name ?? '', before, after: next } },
    },
    { new: true, upsert: true },
  ).lean();
  await logChange({
    entity: 'DecisionPolicy',
    entityId: saved._id,
    action: 'decision rules changed',
    before: { expense: before.spendLimits.expense, payout: before.spendLimits.payout, projectBudget: before.spendLimits.projectBudget, hiring: before.hiringPlansNeedLeadership },
    after: { expense: next.spendLimits.expense, payout: next.spendLimits.payout, projectBudget: next.spendLimits.projectBudget, hiring: next.hiringPlansNeedLeadership },
    fields: ['expense', 'payout', 'projectBudget', 'hiring'],
    note: policySummary(saved),
    by: user._id,
    byName: user.name ?? '',
  });
  // the leaders hear of it (unless they made the change), so a rule never changes behind their back
  await notify({
    recipients: await leaderIds(),
    type: NOTIFICATION_TYPES.POLICY_CHANGED,
    title: 'Decision rules changed',
    body: `${user.name ?? 'Someone'} set what reaches you: ${policySummary(saved)}`,
    link: '/ceo/rules',
    createdBy: user._id ?? null,
    excludeUserId: user._id ?? null,
  });
  return saved;
};

// ── escalating ───────────────────────────────────────────────────────────────

const clearStampDoc = {
  state: 'none', requestId: null, amount: null, checkedBy: null, checkedByName: '', checkedAt: null,
};

/// Take the hold off a source — only if it is still the one for [requestId] (a newer request must not be wiped).
const clearStamp = async (kind, refId, requestId) => {
  const h = HANDLERS[kind];
  if (!h?.stampPath) return;
  await h.Model.updateOne({ _id: refId, [`${h.stampPath}.requestId`]: requestId }, { $set: { [h.stampPath]: clearStampDoc } });
};

/// Take the hold off whatever it is, whoever asked (an item that is edited and goes back to the team).
export const resetStamp = async (kind, refId) => {
  const h = HANDLERS[kind];
  if (!h?.stampPath) return;
  await h.Model.updateOne({ _id: refId }, { $set: { [h.stampPath]: clearStampDoc } });
};

const settleOpen = async (filter, status, { by = null, note = '', now = new Date() } = {}) => {
  const request = await DecisionRequest.findOneAndUpdate(
    { ...filter, open: true },
    {
      $set: { status, decidedBy: by ? personOf(by) : null, decidedAt: now, note: clip(note, 500), appliedAt: now },
      $unset: { open: 1 },
      $push: { history: { at: now, by: personOf(by) ?? {}, action: status, note: clip(note, 500) } },
    },
    { new: true },
  );
  if (request) await clearStamp(request.kind, request.refId, request._id);
  return request;
};

/**
 * The team has checked [source] and it is above the limit: make the request and hold the source. [checker] is the user who checked
 * it (null for a proposal, which nobody checks). → { escalated, request, created } — escalated:false when there is nobody to decide.
 * The caller must NOT approve / pay / post the source when this returns escalated:true.
 */
export const escalate = async ({ kind, source, checker = null, checkNote = '', payload = {}, notifyLeaders = true, now = new Date() }) => {
  const h = HANDLERS[kind];
  if (!h) throw new Error(`Unknown decision kind: ${kind}`);
  if (!(await hasLeadership())) {
    console.warn(`[decisions] no active CEO / Executive Director login: ${kind} ${idStr(source._id)} proceeds without leadership`);
    return { escalated: false, reason: 'NO_LEADERSHIP_ACCOUNT' };
  }
  const snapshot = h.snapshot(source);
  const same = (r) => r && !isMaterialChange(kind, r.payload?.snapshot, snapshot) && Number(r.payload?.amount ?? 0) === Number(payload.amount ?? 0);

  let existing = await DecisionRequest.findOne({ kind, refId: source._id, open: true });
  if (existing && same(existing)) {
    await ensureStamp(h, source, existing, checker);
    return { escalated: true, request: existing, created: false };
  }
  if (existing) await settleOpen({ _id: existing._id }, 'superseded', { by: checker, note: 'Changed, so it was checked again', now });

  const info = h.describe(source, payload);
  const requesterId = h.requesterId(source);
  const requester = requesterId ? await User.findById(requesterId).select('name role').lean() : null;
  let request;
  try {
    request = await DecisionRequest.create({
      kind,
      refModel: h.refModel,
      refId: source._id,
      ...info,
      requestedBy: personOf(requester) ?? {},
      requestedAt: source.createdAt ?? now,
      checkedBy: checker ? personOf(checker) : null,
      checkedAt: checker ? now : null,
      checkNote: clip(checkNote, 500),
      status: 'pending',
      open: true,
      payload: { ...payload, snapshot },
      history: [
        { at: now, by: personOf(requester) ?? {}, action: 'requested' },
        ...(checker ? [{ at: now, by: personOf(checker), action: 'checked', note: clip(checkNote, 500) }] : []),
      ],
    });
  } catch (e) {
    if (e?.code !== 11000) throw e;
    // a double click raised it twice: the other one won
    existing = await DecisionRequest.findOne({ kind, refId: source._id, open: true });
    if (!existing) throw e;
    await ensureStamp(h, source, existing, checker);
    return { escalated: true, request: existing, created: false };
  }
  await ensureStamp(h, source, request, checker);

  if (notifyLeaders) {
    await notify({
      recipients: await leaderIds(),
      type: NOTIFICATION_TYPES.DECISION_REQUEST,
      title: `Needs your decision: ${KIND_LABELS[kind]}`,
      body: `${info.title}${info.amount ? ` — ${money(info.amount)}` : ''}${checker ? `. Verified by ${checker.name}.` : '.'}`,
      link: `/ceo/decisions?focus=${request._id}`,
      createdBy: checker?._id ?? requester?._id ?? null,
    });
  }
  return { escalated: true, request, created: true };
};

const ensureStamp = async (h, source, request, checker) => {
  if (!h.stampPath) return;
  await h.Model.updateOne(
    { _id: source._id },
    {
      $set: {
        [h.stampPath]: {
          state: 'awaiting',
          requestId: request._id,
          amount: request.payload?.amount ?? request.amount ?? null,
          checkedBy: checker?._id ?? request.checkedBy?.id ?? null,
          checkedByName: checker?.name ?? request.checkedBy?.name ?? '',
          checkedAt: request.checkedAt ?? new Date(),
        },
      },
    },
  );
};

/// A project proposal was made: show it to the leaders (nothing is held — the department head decides in parallel).
export const mirrorProposal = async (project) => escalate({ kind: 'project_proposal', source: project, checker: null });

/**
 * The source was edited while it waited. When what the decision rests on changed, the request is superseded (the team checks again);
 * returns it, or null when nothing was waiting or the change does not matter.
 */
export const supersedeFor = async (kind, source, { user = null, reason = 'Changed after it was checked, so it needs checking again', force = false } = {}) => {
  const open = await DecisionRequest.findOne({ kind, refId: source._id, open: true });
  if (!open) return null;
  const h = HANDLERS[kind];
  if (!force && !isMaterialChange(kind, open.payload?.snapshot, h.snapshot(source))) return null;
  return settleAndTell(open, 'superseded', { user, reason });
};

/// The source was deleted, rejected or taken back while it waited: the request goes away. → the request, or null.
export const withdrawFor = async (kind, refId, { user = null, reason = 'No longer needed' } = {}) => {
  const open = await DecisionRequest.findOne({ kind, refId, open: true });
  if (!open) return null;
  return settleAndTell(open, 'withdrawn', { user, reason });
};

const settleAndTell = async (open, status, { user, reason }) => {
  const settled = await settleOpen({ _id: open._id }, status, { by: user, note: reason });
  if (settled) {
    await notify({
      recipients: await leaderIds(),
      type: NOTIFICATION_TYPES.DECISION_WITHDRAWN,
      title: 'No longer waiting for you',
      body: `${settled.title}: ${reason}.`,
      link: '/ceo/decisions',
      createdBy: user?._id ?? null,
      excludeUserId: user?._id ?? null,
    });
  }
  return settled;
};

/// A project proposal was decided by its department head / an administrator: close the leaders' request with their decision.
export const settleProposalRequest = async (project, { approve, user, note = '' }) => {
  const now = new Date();
  const request = await DecisionRequest.findOneAndUpdate(
    { kind: 'project_proposal', refId: project._id, open: true },
    {
      $set: { status: approve ? 'approved' : 'rejected', decidedBy: personOf(user), decidedAt: now, note: clip(note, 500), appliedAt: now },
      $unset: { open: 1 },
      $push: { history: { at: now, by: personOf(user), action: approve ? 'approved' : 'rejected', note: clip(note, 500), meta: { by: 'department head' } } },
    },
    { new: true },
  );
  if (request) {
    await notify({
      recipients: await leaderIds(),
      type: NOTIFICATION_TYPES.DECISION_RESULT,
      title: `${project.name}: proposal ${approve ? 'approved' : 'not approved'}`,
      body: `${user.name ?? 'The department head'} ${approve ? 'approved' : 'did not approve'} it${note ? `: ${clip(note, 200)}` : '.'}`,
      link: '/ceo/decisions',
      createdBy: user._id ?? null,
      excludeUserId: user._id ?? null,
    });
  }
  return request;
};

// ── deciding ─────────────────────────────────────────────────────────────────

const RESULT_LABEL = { approved: 'approved', rejected: 'rejected' };
const SOURCE_LINK = { spend_expense: '/accounts/admin-expenses', spend_payout: '/accounts/artist-payouts', hiring_plan: '/hr/recruitment', project_budget: '/projects', project_proposal: '/projects' };

const notifyResult = async (request, status, user, note) => {
  const verb = RESULT_LABEL[status] ?? status;
  const who = `${user.name ?? 'A leader'} (${leadershipTitle(user.role)})`;
  const body = `${who} ${verb} "${request.title}"${request.amount ? ` — ${money(request.amount)}` : ''}${note ? `: ${clip(note, 200)}` : '.'}`;
  const team = [request.requestedBy?.id, request.checkedBy?.id].filter(Boolean);
  const leaders = await leaderIds();
  await notify({
    recipients: team,
    type: NOTIFICATION_TYPES.DECISION_RESULT,
    title: `${KIND_LABELS[request.kind]} ${verb}`,
    body,
    link: SOURCE_LINK[request.kind] ?? '',
    createdBy: user._id ?? null,
    excludeUserId: user._id ?? null,
  });
  await notify({
    recipients: leaders,
    type: NOTIFICATION_TYPES.DECISION_RESULT,
    title: `${KIND_LABELS[request.kind]} ${verb}`,
    body,
    link: `/ceo/decisions?focus=${request._id}`,
    createdBy: user._id ?? null,
    excludeUserId: user._id ?? null,
  });
};

const conflict = async (id) => {
  const fresh = await DecisionRequest.findById(id).lean();
  return new DecisionError(409, fresh ? conflictBody(fresh) : { code: 'NOT_FOUND', message: 'This request no longer exists.' });
};

const sourceChanged = () =>
  new DecisionError(409, { code: 'SOURCE_CHANGED', message: 'It was changed after the team checked it, so it has gone back to them to check again.' });

/**
 * Carry out a decision that is already recorded. Safe to run again (the retry sweep does). → { request, applied }.
 */
const finishApply = async (request, { action, user, note, now, replay = false }) => {
  const h = HANDLERS[request.kind];
  let outcome;
  try {
    outcome = await h.apply({ request, action, leader: user, note, now });
  } catch (err) {
    const message = clip(err?.message ?? 'Could not apply', 300);
    console.error(`[decisions] could not apply ${request.kind} ${request._id}: ${message}`);
    const failed = await DecisionRequest.findOneAndUpdate(
      { _id: request._id },
      { $set: { applyError: message }, $push: { history: { at: now, by: personOf(user) ?? {}, action: 'apply_failed', note: message } } },
      { new: true },
    );
    await notify({
      recipients: [request.requestedBy?.id, request.checkedBy?.id].filter(Boolean),
      type: NOTIFICATION_TYPES.DECISION_RESULT,
      title: `${KIND_LABELS[request.kind]}: decided, not yet applied`,
      body: `"${request.title}" was ${request.status}, but updating it failed. It will be tried again; tell IT if it stays like this.`,
      link: SOURCE_LINK[request.kind] ?? '',
    });
    return { request: failed ?? request, applied: false };
  }
  if (outcome.result === 'source_changed') {
    await DecisionRequest.updateOne(
      { _id: request._id },
      {
        $set: { status: 'superseded', decidedBy: null, decidedAt: null, note: '', appliedAt: now },
        $push: { history: { at: now, by: personOf(user) ?? {}, action: 'superseded', note: 'The source changed before the decision could be applied' } },
      },
    );
    await clearStamp(request.kind, request.refId, request._id);
    throw sourceChanged();
  }
  const done = await DecisionRequest.findOneAndUpdate(
    { _id: request._id },
    { $set: { appliedAt: now, applyError: '' }, $push: { history: { at: now, by: personOf(user) ?? {}, action: 'applied' } } },
    { new: true },
  );
  if (!replay) await notifyResult(done ?? request, request.status, user, note);
  return { request: done ?? request, applied: true };
};

/**
 * A leader decides. → { request, applied } (applied: null for a deferral). Throws DecisionError:
 *   400 bad input · 404 · 409 ALREADY_DECIDED (who, when, why) / SOURCE_CHANGED
 */
export const decide = async ({ id, user, input, now = new Date() }) => {
  const checked = validateDecision(input, now);
  if (!checked.ok) throw new DecisionError(400, { code: checked.code, message: checked.message });
  const { action, note, until } = checked.value;
  if (!mongoose.isValidObjectId(id)) throw new DecisionError(404, { code: 'NOT_FOUND', message: 'Decision request not found' });
  const request = await DecisionRequest.findById(id);
  if (!request) throw new DecisionError(404, { code: 'NOT_FOUND', message: 'Decision request not found' });
  if (!isOpenStatus(request.status)) throw new DecisionError(409, conflictBody(request));

  // Is it still what the team checked?
  const h = HANDLERS[request.kind];
  const source = await h.load(request.refId);
  if (!source) {
    await settleOpen({ _id: request._id }, 'withdrawn', { note: 'The item no longer exists', now });
    throw await conflict(request._id);
  }
  if (isMaterialChange(request.kind, request.payload?.snapshot, h.snapshot(source)) || !h.stillHeld(source, request)) {
    await settleOpen({ _id: request._id }, 'superseded', { note: 'Changed after it was checked', now });
    throw sourceChanged();
  }

  const by = personOf(user);
  if (action === 'defer') {
    const deferred = await DecisionRequest.findOneAndUpdate(
      { _id: request._id, open: true },
      {
        $set: { status: 'deferred', deferredUntil: until },
        $push: { history: { at: now, by, action: 'deferred', note, meta: { until } } },
      },
      { new: true },
    );
    if (!deferred) throw await conflict(request._id);
    await notify({
      recipients: await leaderIds(),
      type: NOTIFICATION_TYPES.DECISION_RESULT,
      title: `${KIND_LABELS[request.kind]} deferred`,
      body: `${user.name ?? 'A leader'} put "${request.title}" off${until ? ` to ${until.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}${note ? `: ${clip(note, 200)}` : '.'}`,
      link: `/ceo/decisions?focus=${request._id}`,
      createdBy: user._id ?? null,
      excludeUserId: user._id ?? null,
    });
    return { request: deferred, applied: null };
  }

  // The claim: only one of two simultaneous decisions can flip `open`, the other gets the 409.
  const status = nextStatus(request.status, action);
  const claimed = await DecisionRequest.findOneAndUpdate(
    { _id: request._id, open: true },
    {
      $set: { status, decidedBy: by, decidedAt: now, note, applyError: '' },
      $unset: { open: 1 },
      $push: { history: { at: now, by, action: status, note } },
    },
    { new: true },
  );
  if (!claimed) throw await conflict(request._id);
  return finishApply(claimed, { action, user, note, now });
};

/// Decisions that were recorded but whose source change did not finish (a crash, a failure): try them again.
export const retryUnapplied = async ({ now = new Date(), limit = 20 } = {}) => {
  const stale = new Date(now.getTime() - 2 * 60_000);
  const stuck = await DecisionRequest.find({ status: { $in: ['approved', 'rejected'] }, appliedAt: null, decidedAt: { $lt: stale } }).sort({ decidedAt: 1 }).limit(limit);
  let fixed = 0;
  for (const request of stuck) {
    const leader = request.decidedBy?.id ? await User.findById(request.decidedBy.id) : null;
    if (!leader) continue;
    try {
      const out = await finishApply(request, { action: request.status === 'approved' ? 'approve' : 'reject', user: leader, note: request.note, now, replay: true });
      if (out.applied) fixed += 1;
    } catch {
      // superseded by finishApply: it is settled
    }
  }
  return fixed;
};

// ── keeping it honest ────────────────────────────────────────────────────────

let lastSync = 0;
// how often a read of the queue may run the repairs (ms); tests set it to 0
const SYNC_EVERY_MS = Number(process.env.DECISIONS_SYNC_MS ?? 20_000);

/**
 * Repairs: proposals made before this existed get a request; a proposal decided elsewhere closes its request; an open request whose
 * source was deleted / changed / released is withdrawn or superseded; decisions that were not applied are retried. Throttled (a read of
 * the queue triggers it).
 */
export const syncOpen = async ({ force = false, now = new Date() } = {}) => {
  if (!force && now.getTime() - lastSync < SYNC_EVERY_MS) return;
  lastSync = now.getTime();
  try {
    // 1. proposals without a request (only when a leader exists to see them)
    if (await hasLeadership()) {
      const proposed = await Project.find({ status: 'proposed' }).select('_id').limit(200).lean();
      if (proposed.length) {
        const have = new Set((await DecisionRequest.find({ kind: 'project_proposal', open: true, refId: { $in: proposed.map((p) => p._id) } }).select('refId').lean()).map((r) => idStr(r.refId)));
        for (const { _id } of proposed) {
          if (have.has(idStr(_id))) continue;
          const project = await Project.findById(_id);
          if (project?.status === 'proposed') await escalate({ kind: 'project_proposal', source: project, notifyLeaders: false, now });
        }
      }
    }
    // 2. open requests whose source went away or moved on
    const open = await DecisionRequest.find({ open: true }).limit(300);
    for (const request of open) {
      const h = HANDLERS[request.kind];
      const source = await h.load(request.refId);
      if (!source) {
        await settleOpen({ _id: request._id }, 'withdrawn', { note: 'The item no longer exists', now });
      } else if (request.kind === 'project_proposal' && source.status !== 'proposed') {
        const approve = source.status !== 'cancelled';
        const decider = source.decidedBy ? await User.findById(source.decidedBy).select('name role').lean() : null;
        await DecisionRequest.updateOne(
          { _id: request._id, open: true },
          {
            $set: { status: approve ? 'approved' : 'rejected', decidedBy: decider ? personOf(decider) : null, decidedAt: source.decidedAt ?? now, note: clip(source.decisionNote, 500), appliedAt: now },
            $unset: { open: 1 },
            $push: { history: { at: now, by: decider ? personOf(decider) : {}, action: approve ? 'approved' : 'rejected', note: clip(source.decisionNote, 500) } },
          },
        );
      } else if (request.kind !== 'project_proposal' && !h.stillHeld(source, request)) {
        await settleOpen({ _id: request._id }, 'superseded', { note: 'It was released or changed outside the decision', now });
      }
    }
    // 3. decisions that did not finish
    await retryUnapplied({ now });
  } catch (err) {
    console.error('[decisions] sync failed:', err.message);
  }
};

// ── reading ──────────────────────────────────────────────────────────────────

export const counts = async (now = new Date()) => {
  const open = await DecisionRequest.find({ open: true }).select('kind status deferredUntil checkedAt requestedAt createdAt').lean();
  const byKind = {};
  let pending = 0;
  let deferred = 0;
  let oldest = null;
  for (const r of open) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const hidden = r.status === 'deferred' && r.deferredUntil && new Date(r.deferredUntil) > now;
    if (hidden) deferred += 1;
    else pending += 1;
    const since = r.checkedAt ?? r.requestedAt ?? r.createdAt;
    if (!hidden && since && (!oldest || new Date(since) < oldest)) oldest = new Date(since);
  }
  return { open: open.length, pending, deferred, byKind, oldestDays: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 86_400_000)) : 0 };
};

export const listQueue = async ({ scope = 'open', kind = '', status = '', limit = 50, cursor = '', user, now = new Date() }) => {
  await syncOpen({ now });
  const filter = {};
  if (scope === 'decided') filter.status = status && ['approved', 'rejected', 'withdrawn', 'superseded'].includes(status) ? status : { $in: ['approved', 'rejected'] };
  else filter.open = true;
  if (KINDS.includes(kind)) filter.kind = kind;
  const take = Math.min(100, Math.max(1, Number(limit) || 50));
  const skip = Math.max(0, Number(cursor) || 0);
  const sort = scope === 'decided' ? { decidedAt: -1 } : { checkedAt: 1, createdAt: 1 };
  const rows = await DecisionRequest.find(filter).sort(sort).skip(skip).limit(take + 1).lean();
  const page = rows.slice(0, take);
  const canDecide = isLeadership(user);
  return {
    items: page.map((r) => shapeRequest(r, { now, canDecide })),
    nextCursor: rows.length > take ? String(skip + take) : null,
    counts: await counts(now),
  };
};

/// May this user read what happened to a request? Leaders and admins always; the team that raised / checked it; Finance and HR.
export const mayRead = (user, request) => {
  const role = String(user?.role ?? '').toLowerCase();
  if (isLeadership(user) || ['admin', 'manager', 'accounts', 'finance_head'].includes(role)) return true;
  const me = idStr(user?._id);
  return [request?.requestedBy?.id, request?.checkedBy?.id].some((p) => p && idStr(p) === me);
};

export const getOne = async (id, user, now = new Date()) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const request = await DecisionRequest.findById(id).lean();
  if (!request) return null;
  if (!mayRead(user, request)) throw new DecisionError(403, { message: 'This decision is not for you to see.' });
  return {
    ...shapeRequest(request, { now, canDecide: isLeadership(user) }),
    history: (request.history ?? []).map((h) => ({ at: h.at, action: h.action, note: h.note ?? '', by: h.by?.name ? { name: h.by.name, role: h.by.role ?? '' } : null })),
  };
};

/// What happened to a source item (so Accounts / HR can say "With the CEO / ED" and show the note): its latest request.
export const forRef = async (refModel, refId, user, now = new Date()) => {
  if (!mongoose.isValidObjectId(refId)) return null;
  const request = await DecisionRequest.findOne({ refModel, refId }).sort({ createdAt: -1 }).lean();
  if (!request || !mayRead(user, request)) return null;
  return shapeRequest(request, { now, canDecide: isLeadership(user) });
};

/// The leaders' desk in a nutshell, for the CEO inbox.
export const deskSummary = async (now = new Date()) => {
  await syncOpen({ now });
  const [c, preview, recent] = await Promise.all([
    counts(now),
    DecisionRequest.find({ open: true }).sort({ checkedAt: 1, createdAt: 1 }).limit(12).lean(),
    DecisionRequest.find({ status: { $in: ['approved', 'rejected'] } }).sort({ decidedAt: -1 }).limit(5).lean(),
  ]);
  const visible = preview.filter((r) => !(r.status === 'deferred' && r.deferredUntil && new Date(r.deferredUntil) > now)).slice(0, 5);
  return {
    decisions: { ...c, preview: visible.map((r) => shapeRequest(r, { now, canDecide: true })) },
    recent: recent.map((r) => shapeRequest(r, { now })),
  };
};

export { needsLeadership, OPEN_STATUSES };
