import CeoDecision, { DECISION_TYPES, DECISION_STATUSES } from '../models/CeoDecision.js';
import { LEADERSHIP_ROLES, isLeadership } from '../utils/leadership.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts', 'finance_head', ...LEADERSHIP_ROLES]; // + leadership (CEO, Executive Director): enforced in middleware/ceoGuard.js
const canView = (u) => {
  const role = String(u?.role ?? '').trim().toLowerCase();
  if (FINANCE_ROLES.includes(role)) return true;
  const perms = Array.isArray(u?.permissions) ? u.permissions : [];
  return perms.some((p) => p === 'company_finance.month_end' || p === 'company_finance' || p === 'ceo');
};

// The log is a record the leaders keep. Anyone who may open it can add to it; settling an entry (approved / rejected / done /
// deferred / reopened) is for the CEO, the Executive Director and the administrators — not for Accounts.
const roleOf = (u) => String(u?.role ?? '').trim().toLowerCase();
const canSettle = (u) => isLeadership(u) || ['admin', 'manager'].includes(roleOf(u));
const canRemove = (u, doc) => isLeadership(u) || roleOf(u) === 'admin' || (doc.status === 'pending' && String(doc.createdBy ?? '') === String(u?._id ?? ''));

// @route  GET /api/reports/decisions?month=&year=&status=&scope=open
// scope=open ignores month/year and returns every unresolved decision (the
// running CEO to-do list); otherwise it's scoped to the meeting month.
export const getDecisions = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const filter = { deletedAt: null };
    if (req.query.scope === 'open') {
      filter.status = { $in: ['pending', 'deferred'] };
    } else {
      if (req.query.month) filter.month = Number(req.query.month);
      if (req.query.year) filter.year = Number(req.query.year);
      if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    }
    const items = await CeoDecision.find(filter).sort({ dueDate: 1, createdAt: -1 }).lean();
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  POST /api/reports/decisions
export const createDecision = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const now = new Date();
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ message: 'A title is required' });
    const doc = await CeoDecision.create({
      month: Number(req.body.month) || now.getMonth() + 1,
      year: Number(req.body.year) || now.getFullYear(),
      type: DECISION_TYPES.includes(req.body.type) ? req.body.type : 'action_item',
      title,
      description: req.body.description || '',
      amount: Number(req.body.amount) || 0,
      status: DECISION_STATUSES.includes(req.body.status) ? req.body.status : 'pending',
      owner: req.body.owner || '',
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
      createdBy: req.user?._id || null,
    });
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  PUT /api/reports/decisions/:id
export const updateDecision = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const doc = await CeoDecision.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Decision not found' });

    if (doc.deletedAt) return res.status(404).json({ message: 'Decision not found' });
    const b = req.body;
    const changesStatus = b.status !== undefined && DECISION_STATUSES.includes(b.status) && b.status !== doc.status;
    if (changesStatus && !canSettle(req.user)) {
      return res.status(403).json({ message: 'Only the CEO, the Executive Director or an administrator can change the status of an entry.' });
    }
    if (b.month !== undefined) doc.month = Number(b.month) || doc.month;
    if (b.year !== undefined) doc.year = Number(b.year) || doc.year;
    if (b.type !== undefined && DECISION_TYPES.includes(b.type)) doc.type = b.type;
    if (b.title !== undefined) doc.title = String(b.title).trim();
    if (b.description !== undefined) doc.description = b.description;
    if (b.amount !== undefined) doc.amount = Number(b.amount) || 0;
    if (b.owner !== undefined) doc.owner = b.owner;
    if (b.dueDate !== undefined) doc.dueDate = b.dueDate ? new Date(b.dueDate) : null;
    if (changesStatus) {
      const note = String(b.note ?? '').trim().slice(0, 500);
      const now = new Date();
      doc.statusHistory.push({ at: now, by: req.user?._id ?? null, byName: req.user?.name ?? '', from: doc.status, to: b.status, note });
      doc.status = b.status;
      // Who settled it, when and why. Reopening it keeps these (the history shows the turn) — it is not erased.
      if (['approved', 'rejected', 'done'].includes(b.status)) {
        doc.decidedBy = req.user?._id || null;
        doc.decidedAt = now;
        doc.decidedByName = req.user?.name ?? '';
        doc.decidedByRole = roleOf(req.user);
        doc.decisionNote = note;
      }
    }
    await doc.save();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  DELETE /api/reports/decisions/:id
export const deleteDecision = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const doc = await CeoDecision.findById(req.params.id);
    if (!doc || doc.deletedAt) return res.status(404).json({ message: 'Decision not found' });
    if (!canRemove(req.user, doc)) {
      return res.status(403).json({ message: 'You can remove only an entry you added that is still pending. The CEO, the Executive Director or an administrator can remove any.' });
    }
    // hidden, not erased
    doc.deletedAt = new Date();
    doc.deletedBy = req.user?._id ?? null;
    await doc.save();
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
