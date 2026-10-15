import ApprovalRequest from '../models/ApprovalRequest.js';
import { canActOnApproval, decideApproval } from '../services/approvals.js';

const populate = [
  { path: 'requesterEmployeeId', select: 'name department profileImage' },
  { path: 'subjectEmployeeId', select: 'name department profileImage' },
];

// @desc  Pending approvals the signed-in user can act on (their inbox).
// @route GET /api/approvals/inbox
export const getApprovalInbox = async (req, res) => {
  try {
    const all = await ApprovalRequest.find({ status: 'pending' })
      .populate(populate)
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();

    const role = String(req.user.role || '');
    const uid = String(req.user._id);
    const inbox = all.filter((a) => {
      const step = a.chain?.[a.currentLevel];
      if (!step) return false;
      if (step.approverUserId && String(step.approverUserId) === uid) return true;
      if (step.approverRole && role === step.approverRole) return true;
      if (role === 'admin' || role === 'manager') return true;
      return false;
    });
    res.json(inbox);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Approvals the signed-in user raised (their own requests).
// @route GET /api/approvals/mine
export const getMyApprovals = async (req, res) => {
  try {
    const or = [];
    if (req.user._id) or.push({ requesterUserId: req.user._id });
    if (req.user.employeeId) or.push({ requesterEmployeeId: req.user.employeeId });
    if (!or.length) return res.json([]);
    const list = await ApprovalRequest.find({ $or: or })
      .populate(populate)
      .sort({ createdAt: -1 })
      .limit(200);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc  Full approvals log (HR/admin), filterable by module/status.
// @route GET /api/approvals/history
export const getApprovalHistory = async (req, res) => {
  try {
    const { module, status } = req.query;
    const filter = {};
    if (module && module !== 'all') filter.module = module;
    if (status && status !== 'all') filter.status = status;
    const list = await ApprovalRequest.find(filter)
      .populate(populate)
      .sort({ updatedAt: -1 })
      .limit(300);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const act = (decision) => async (req, res) => {
  try {
    const approval = await ApprovalRequest.findById(req.params.id);
    if (!approval) return res.status(404).json({ message: 'Approval not found' });
    if (!canActOnApproval(approval, req.user)) {
      return res.status(403).json({ message: 'You cannot act on this request' });
    }
    await decideApproval(approval, req.user, decision, req.body?.note || '');
    const populated = await ApprovalRequest.findById(approval._id).populate(populate);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @route POST /api/approvals/:id/approve
export const approveApproval = act('approve');
// @route POST /api/approvals/:id/reject
export const rejectApproval = act('reject');
