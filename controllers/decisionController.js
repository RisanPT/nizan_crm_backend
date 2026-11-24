import { isLeadership } from '../utils/leadership.js';
import {
  DecisionError, decide as decideRequest, listQueue, getOne, forRef, getPolicy, policyView, savePolicy, hasLeadership,
} from '../services/decisions.js';
import { DECISION_REF_MODELS } from '../models/DecisionRequest.js';

// The CEO / Executive Director's desk: what waits for them, deciding, and the rules for what reaches them.

const roleOf = (u) => String(u?.role ?? '').toLowerCase();
const isAdmin = (u) => roleOf(u) === 'admin';
// who may read the queue: the leaders, and the administrators who look after the account
const canReadDesk = (u) => isLeadership(u) || isAdmin(u) || roleOf(u) === 'manager';
// who may read the rules: those who would otherwise be surprised by a request going to the leaders — the desk, Accounts, the finance
// head and HR's recruiters (the limits are not for every department head)
const canReadRules = (u) =>
  canReadDesk(u) || ['accounts', 'finance_head'].includes(roleOf(u)) || (u?.permissions ?? []).some((p) => p === 'recruitment' || p === 'recruitment.plans');

const fail = (res, error) => {
  if (error instanceof DecisionError) return res.status(error.status).json(error.body);
  return res.status(500).json({ message: error.message });
};

// @route GET /api/decisions/queue?scope=open|decided&kind=&status=&limit=&cursor=
export const getQueue = async (req, res) => {
  try {
    if (!canReadDesk(req.user)) return res.status(403).json({ message: 'The decisions desk is for the CEO and the Executive Director.' });
    const { scope, kind, status, limit, cursor } = req.query;
    res.json(await listQueue({ scope: scope === 'decided' ? 'decided' : 'open', kind, status, limit, cursor, user: req.user }));
  } catch (error) {
    fail(res, error);
  }
};

// @route GET /api/decisions/by-ref?model=AdminExpense&id=…   (what happened to a source item: for Accounts / HR to show "With the CEO / ED")
export const getByRef = async (req, res) => {
  try {
    const model = String(req.query.model ?? '');
    if (!DECISION_REF_MODELS.includes(model)) return res.status(400).json({ message: 'Unknown item type.' });
    const found = await forRef(model, req.query.id, req.user);
    res.json({ request: found });
  } catch (error) {
    fail(res, error);
  }
};

// @route GET /api/decisions/:id
export const getRequest = async (req, res) => {
  try {
    const found = await getOne(req.params.id, req.user);
    if (!found) return res.status(404).json({ message: 'Decision request not found' });
    res.json(found);
  } catch (error) {
    fail(res, error);
  }
};

// @route POST /api/decisions/:id/decide   { action: 'approve' | 'reject' | 'defer', note?, until? }
export const decide = async (req, res) => {
  try {
    if (!isLeadership(req.user)) return res.status(403).json({ code: 'LEADERSHIP_ONLY', message: 'Only the CEO or the Executive Director can decide on this.' });
    const out = await decideRequest({ id: req.params.id, user: req.user, input: req.body ?? {} });
    const shaped = (await getOne(req.params.id, req.user)) ?? null;
    res.json({ ...shaped, applied: out.applied });
  } catch (error) {
    fail(res, error);
  }
};

// @route GET /api/decision-policy
export const getDecisionPolicy = async (req, res) => {
  try {
    if (!canReadRules(req.user)) return res.status(403).json({ message: 'Not authorized to see the decision rules.' });
    res.json({ ...policyView(await getPolicy()), canEdit: isLeadership(req.user) || isAdmin(req.user), hasLeadership: await hasLeadership() });
  } catch (error) {
    fail(res, error);
  }
};

// @route PUT /api/decision-policy   { spendLimits?: { expense?, payout?, projectBudget? }, hiringPlansNeedLeadership? }
export const updateDecisionPolicy = async (req, res) => {
  try {
    if (!(isLeadership(req.user) || isAdmin(req.user))) {
      return res.status(403).json({ message: 'Only an administrator, the CEO or the Executive Director can change what reaches the CEO / Executive Director.' });
    }
    const saved = await savePolicy({ body: req.body ?? {}, user: req.user });
    res.json({ ...policyView(saved), canEdit: true, hasLeadership: await hasLeadership() });
  } catch (error) {
    fail(res, error);
  }
};
