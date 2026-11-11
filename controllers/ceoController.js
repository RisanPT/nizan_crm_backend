import { loadCeoInbox, loadCeoSignals } from '../services/ceoInbox.js';

// The CEO home. Everyone who may open the CEO screen sees the same company-wide numbers.
const VIEW_ROLES = ['ceo', 'admin', 'manager'];
const canView = (u) => VIEW_ROLES.includes(String(u?.role ?? '').trim().toLowerCase());

// @desc    What needs the CEO, and what is waiting (and for how long) with the team
// @route   GET /api/ceo/inbox
// @returns { items: [{ key, label, owner: 'you'|'team', withWhom, count, amount, oldestDays, route }], needsYou, withTeam, oldestTeamDays }
export const getCeoInbox = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'The CEO screen is for the CEO.' });
  try {
    res.json(await loadCeoInbox());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    The watch list: projects past their end date, blocked objectives, milestones at risk, low stock, cancellations, NPS
// @route   GET /api/ceo/signals
// @returns [{ key, label, value, previous?, severity: 'ok'|'watch'|'alert', route }]
export const getCeoSignals = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'The CEO screen is for the CEO.' });
  try {
    res.json(await loadCeoSignals());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
