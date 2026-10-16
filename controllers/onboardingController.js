import asyncHandler from 'express-async-handler';
import Onboarding, { DEFAULT_ONBOARDING_TASKS } from '../models/Onboarding.js';
import Employee from '../models/Employee.js';
import Candidate from '../models/Candidate.js';
import { linkHiredCandidateToOnboarding } from './recruitmentController.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage role designationId' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('onboarding') || perms.includes('recruitment') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage onboarding');
  }
};

const cleanTasks = (tasks) =>
  (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && String(t.title || '').trim())
    .map((t) => ({
      title: String(t.title).trim(),
      done: Boolean(t.done),
      owner: String(t.owner || '').trim(),
      dueDate: t.dueDate ? new Date(t.dueDate) : null,
      note: String(t.note || '').trim(),
    }));

const cleanDocuments = (docs) =>
  (Array.isArray(docs) ? docs : [])
    .filter((d) => d && String(d.name || '').trim())
    .map((d) => ({
      name: String(d.name).trim(),
      owner: String(d.owner || '').trim(),
      required: d.required !== false,
      status: String(d.status || 'Pending').trim(),
    }));

const getOnboardings = asyncHandler(async (req, res) => {
  // Auto-sync: ensure any candidate marked 'hired' is linked to an onboarding record
  try {
    const hiredCandidates = await Candidate.find({ stage: 'hired' });
    for (const cand of hiredCandidates) {
      const existing = await Onboarding.findOne({
        $or: [{ candidateId: cand._id }, { employeeName: cand.name }],
      });
      if (!existing) {
        await linkHiredCandidateToOnboarding(cand, req.user?._id);
      }
    }
  } catch (err) {
    console.error('Error auto-syncing hired candidates to onboarding:', err);
  }

  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  const rows = await Onboarding.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(300);
  res.json(rows);
});

const createOnboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  const employee = await Employee.findById(employeeId).select('name department role');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const tasks = Array.isArray(req.body.tasks) && req.body.tasks.length
    ? cleanTasks(req.body.tasks)
    : DEFAULT_ONBOARDING_TASKS.map((t) => ({ title: t, done: false }));

  const documents = Array.isArray(req.body.documents) && req.body.documents.length
    ? cleanDocuments(req.body.documents)
    : [
        { name: 'Signed offer letter', owner: employee.name, required: true, status: 'Received' },
        { name: 'Aadhaar & PAN', owner: employee.name, required: true, status: 'Pending' },
        { name: 'Bank account proof', owner: employee.name, required: true, status: 'Pending' },
        { name: 'Previous experience letter', owner: employee.name, required: false, status: 'Not required' },
        { name: 'Education certificates', owner: employee.name, required: true, status: 'Pending' },
      ];

  const row = await Onboarding.create({
    employeeId,
    employeeName: employee.name,
    department: req.body.department || employee.department || '',
    role: req.body.role || employee.role || '',
    joiningDate: req.body.joiningDate ? new Date(req.body.joiningDate) : new Date(Date.now() + 14 * 86400000),
    tasks,
    documents,
    createdBy: req.user?._id || null,
  });
  await row.populate(empPopulate);
  res.status(201).json(row);
});

const updateOnboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Onboarding.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Onboarding not found'); }
  if (Array.isArray(req.body.tasks)) row.tasks = cleanTasks(req.body.tasks);
  if (Array.isArray(req.body.documents)) row.documents = cleanDocuments(req.body.documents);
  if (req.body.role !== undefined) row.role = String(req.body.role).trim();
  if (req.body.department !== undefined) row.department = String(req.body.department).trim();
  if (req.body.joiningDate !== undefined) row.joiningDate = req.body.joiningDate ? new Date(req.body.joiningDate) : null;
  if (req.body.status !== undefined) row.status = req.body.status;
  // Auto-complete when every task is ticked (unless explicitly reopened).
  const allDone = row.tasks.length > 0 && row.tasks.every((t) => t.done);
  if ((req.body.status === 'completed' || allDone) && req.body.status !== 'in_progress') {
    row.status = 'completed';
    row.completedOn = row.completedOn || new Date();
  } else if (req.body.status === 'in_progress') {
    row.completedOn = null;
  }
  await row.save();
  await row.populate(empPopulate);
  res.json(row);
});

const deleteOnboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Onboarding.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Onboarding not found'); }
  if (row.candidateId) {
    await Candidate.findByIdAndUpdate(row.candidateId, { stage: 'archived' });
  }
  await Onboarding.findByIdAndDelete(req.params.id);
  res.json({ message: 'Onboarding removed', id: req.params.id });
});

export { getOnboardings, createOnboarding, updateOnboarding, deleteOnboarding };
