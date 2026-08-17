import CeoDecision, { DECISION_TYPES, DECISION_STATUSES } from '../models/CeoDecision.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canView = (u) => FINANCE_ROLES.includes(u?.role);

// @route  GET /api/reports/decisions?month=&year=&status=&scope=open
// scope=open ignores month/year and returns every unresolved decision (the
// running CEO to-do list); otherwise it's scoped to the meeting month.
export const getDecisions = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const filter = {};
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

    const b = req.body;
    if (b.type !== undefined && DECISION_TYPES.includes(b.type)) doc.type = b.type;
    if (b.title !== undefined) doc.title = String(b.title).trim();
    if (b.description !== undefined) doc.description = b.description;
    if (b.amount !== undefined) doc.amount = Number(b.amount) || 0;
    if (b.owner !== undefined) doc.owner = b.owner;
    if (b.dueDate !== undefined) doc.dueDate = b.dueDate ? new Date(b.dueDate) : null;
    if (b.status !== undefined && DECISION_STATUSES.includes(b.status)) {
      doc.status = b.status;
      // Record who resolved it once it leaves the pending pile.
      if (['approved', 'rejected', 'done'].includes(b.status)) {
        doc.decidedBy = req.user?._id || null;
        doc.decidedAt = new Date();
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
    const doc = await CeoDecision.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Decision not found' });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
