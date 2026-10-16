/**
 * Approval engine helpers — shared by every HR module that needs sign-off.
 *
 * A caller builds a `chain` (ordered steps, each addressed to a specific user OR
 * a role) and calls createApproval(). Approvers act via decideApproval(); when
 * the chain terminates, onApprovalResolved() updates the source domain document.
 *
 * This module imports MODELS only (never controllers), so there is no import
 * cycle with the controllers that call it.
 */
import ApprovalRequest from '../models/ApprovalRequest.js';
import User from '../models/User.js';
import LeaveRequest from '../models/LeaveRequest.js';
import CompOff from '../models/CompOff.js';
import Timesheet from '../models/Timesheet.js';
import AttendanceRegularization from '../models/AttendanceRegularization.js';
import ExpenseClaim from '../models/ExpenseClaim.js';
import TravelRequest from '../models/TravelRequest.js';
import CompensationRevision from '../models/CompensationRevision.js';
import Employee from '../models/Employee.js';
import SalaryIncrement from '../models/SalaryIncrement.js';
import { notify } from '../utils/notify.js';

// A plain {module→Model} map for request types whose only resolution is "set the
// source doc's status + decision metadata". Richer side effects (leave comp-off,
// compensation apply) stay as explicit branches in onApprovalResolved.
const SIMPLE_STATUS_MODELS = {
  Timesheet,
  AttendanceRegularization,
  ExpenseClaim,
  TravelRequest,
};

const idStr = (v) => (v == null ? '' : String(v._id ?? v));

/// The active-step approver user ids (a named user, or everyone holding a role).
async function resolveStepApproverUserIds(step) {
  if (!step) return [];
  if (step.approverUserId) return [step.approverUserId];
  if (step.approverRole) {
    const users = await User.find({
      role: step.approverRole,
      active: { $ne: false },
    }).select('_id');
    return users.map((u) => u._id);
  }
  return [];
}

async function notifyStepApprovers(approval, level, { type, title, body, actor }) {
  const ids = await resolveStepApproverUserIds(approval.chain[level]);
  if (!ids.length) return;
  await notify({
    recipients: ids,
    type,
    title: title || 'Approval needed',
    body: body || '',
    link: approval.link || '',
    createdBy: actor || null,
    excludeUserId: actor || null,
  });
}

/**
 * Create an ApprovalRequest with an ordered chain and notify the first approver.
 * An empty chain auto-approves (and immediately resolves the source doc).
 */
export async function createApproval({
  module,
  title = '',
  summary = '',
  requesterEmployeeId = null,
  requesterUserId = null,
  subjectEmployeeId = null,
  refModel = '',
  refId = null,
  amount = 0,
  chain = [],
  slaHours = 24,
  link = '',
  createdBy = null,
}) {
  const steps = (chain || []).map((s, i) => ({
    level: i,
    label: s.label || '',
    approverUserId: s.approverUserId || null,
    approverRole: s.approverRole ? String(s.approverRole).toLowerCase() : '',
    state: 'pending',
  }));

  const approval = await ApprovalRequest.create({
    module,
    title,
    summary,
    requesterEmployeeId,
    requesterUserId,
    subjectEmployeeId,
    refModel,
    refId,
    amount,
    chain: steps,
    currentLevel: 0,
    status: steps.length ? 'pending' : 'approved',
    slaHours,
    link,
    createdBy,
  });

  if (!steps.length) {
    await onApprovalResolved(approval);
  } else {
    await notifyStepApprovers(approval, 0, {
      type: 'approval_requested',
      title: title || 'Approval needed',
      body: summary,
      actor: createdBy,
    });
  }
  return approval;
}

/// Whether `user` may act on the live step of a (pending) approval.
export function canActOnApproval(approval, user) {
  if (!approval || approval.status !== 'pending') return false;
  const step = approval.chain[approval.currentLevel];
  if (!step) return false;
  if (step.approverUserId && idStr(step.approverUserId) === idStr(user._id)) return true;
  if (step.approverRole && String(user.role || '') === step.approverRole) return true;
  // Admin / manager can always unblock a stuck request.
  if (['admin', 'manager'].includes(String(user.role || ''))) return true;
  return false;
}

/// Approve or reject the live step; advance, finalise and resolve as needed.
export async function decideApproval(approval, user, decision, note = '') {
  const step = approval.chain[approval.currentLevel];
  if (!step) throw new Error('No active approval step');

  step.state = decision === 'approve' ? 'approved' : 'rejected';
  step.decidedBy = user._id;
  step.decidedAt = new Date();
  step.note = note || '';

  if (decision === 'reject') {
    approval.status = 'rejected';
  } else if (approval.currentLevel + 1 < approval.chain.length) {
    approval.currentLevel += 1;
  } else {
    approval.status = 'approved';
  }

  approval.markModified('chain');
  await approval.save();

  // Tell the requester what happened.
  if (approval.requesterUserId) {
    const outcome =
      approval.status === 'pending' ? 'moved to the next approver' : approval.status;
    await notify({
      recipients: [approval.requesterUserId],
      type: 'approval_decided',
      title: `${approval.title || 'Request'} — ${outcome}`,
      body: note || '',
      link: approval.link || '',
      createdBy: user._id,
      excludeUserId: user._id,
    });
  }

  if (approval.status === 'pending') {
    await notifyStepApprovers(approval, approval.currentLevel, {
      type: 'approval_requested',
      title: approval.title || 'Approval needed',
      body: approval.summary,
      actor: user._id,
    });
  } else {
    await onApprovalResolved(approval);
  }
  return approval;
}

/// React in the source domain when an approval terminates (approved/rejected).
export async function onApprovalResolved(approval) {
  try {
    if (approval.refModel === 'LeaveRequest' && approval.refId) {
      const lr = await LeaveRequest.findById(approval.refId);
      if (lr && lr.status === 'pending') {
        lr.status = approval.status === 'approved' ? 'approved' : 'rejected';
        const lastDecided = [...(approval.chain || [])]
          .reverse()
          .find((s) => s.decidedBy);
        lr.decidedBy = lastDecided?.decidedBy || null;
        lr.decidedAt = new Date();
        lr.decisionNote = lastDecided?.note || '';
        await lr.save();
        if (lr.status === 'approved' && lr.compOffId) {
          await CompOff.updateOne(
            { _id: lr.compOffId },
            { $set: { status: 'used', usedInLeaveId: lr._id } }
          );
        }
      }
    }
    // Request types that just carry a status + decision metadata.
    const Model = SIMPLE_STATUS_MODELS[approval.refModel];
    if (Model && approval.refId) {
      const doc = await Model.findById(approval.refId);
      if (doc && doc.status === 'pending') {
        doc.status = approval.status === 'approved' ? 'approved' : 'rejected';
        const lastDecided = [...(approval.chain || [])].reverse().find((s) => s.decidedBy);
        doc.decidedBy = lastDecided?.decidedBy || null;
        doc.decidedAt = new Date();
        doc.decisionNote = lastDecided?.note || '';
        await doc.save();
      }
    }
    // Compensation revision: set status, and on approval apply the new base
    // salary to the Employee + write a SalaryIncrement history row.
    if (approval.refModel === 'CompensationRevision' && approval.refId) {
      const rev = await CompensationRevision.findById(approval.refId);
      if (rev && rev.status === 'pending') {
        const lastDecided = [...(approval.chain || [])].reverse().find((s) => s.decidedBy);
        rev.status = approval.status === 'approved' ? 'approved' : 'rejected';
        rev.decidedBy = lastDecided?.decidedBy || null;
        rev.decidedAt = new Date();
        rev.decisionNote = lastDecided?.note || '';
        if (rev.status === 'approved') {
          const emp = await Employee.findById(rev.employeeId);
          if (emp) {
            const previous = emp.baseSalary || 0;
            emp.baseSalary = rev.proposedSalary;
            await emp.save();
            rev.appliedAt = new Date();
            try {
              await SalaryIncrement.create({
                employeeId: emp._id,
                previousSalary: previous,
                newSalary: rev.proposedSalary,
                reason: rev.reason || 'Compensation revision',
                effectiveDate: rev.effectiveDate || new Date(),
                appliedBy: rev.createdBy || null,
              });
            } catch (incErr) {
              console.error('SalaryIncrement write failed:', incErr.message);
            }
          }
        }
        await rev.save();
      }
    }
  } catch (err) {
    console.error('onApprovalResolved failed:', err.message);
  }
}
