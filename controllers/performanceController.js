import PerformanceEvaluation, { PILLARS } from '../models/PerformanceEvaluation.js';
import Employee from '../models/Employee.js';
import { getHrScope, canManageEmployee } from '../utils/hrDeptScope.js';

// Permission key granting company-wide evaluation rights (the HR dept head and
// 'staff'-module roles are company-wide too, see utils/hrDeptScope.js).
const KEYS = ['performance'];

// "HR / Admin (anyone)" tier — admin / manager and the `hr` role (added
// 2026-11-16) evaluate anyone. Department heads may evaluate only their own team.
const isAdmin = (u) =>
  ['admin', 'manager', 'ceo', 'hr'].includes(String(u?.role || '').trim().toLowerCase()); // + 'ceo': read-only, enforced in middleware/ceoGuard.js

// Department heads are scoped to the staff of the department(s) they head;
// the HR department head is company-wide.
const canEvaluate = async (req, employeeId) =>
  isAdmin(req.user) || (await canManageEmployee(req, employeeId, KEYS));

const isSelf = (req, employeeId) =>
  !!req.user?.employeeId &&
  String(employeeId?._id ?? employeeId ?? '') === String(req.user.employeeId);

const clampScore = (v) => Math.max(0, Math.min(5, Number(v) || 0));

const populate = [
  { path: 'employeeId', select: 'name department departmentId artistRole profileImage status' },
  { path: 'evaluatedBy', select: 'name role' },
];

// @route GET /api/performance?month=&year=&employeeId=&departmentId=
export const getEvaluations = async (req, res) => {
  try {
    const scope = isAdmin(req.user) ? { wide: true } : await getHrScope(req, KEYS);
    if (!scope.wide && scope.none) {
      // A department head whose department can't be resolved sees nothing
      // (never a departmentId = null match); everyone else is not allowed.
      if (req.user?.isDepartmentHead) return res.json([]);
      return res.status(403).json({ message: 'Not authorized to view evaluations' });
    }
    const { month, year, employeeId, departmentId } = req.query;
    const filter = {};
    if (month) filter.month = Number(month);
    if (year) filter.year = Number(year);
    if (employeeId) filter.employeeId = employeeId;
    if (departmentId) filter.departmentId = departmentId;

    // Department heads: only their own department's staff ($and so a query
    // employeeId can't widen it).
    const finalFilter = scope.wide
      ? filter
      : { $and: [filter, { employeeId: { $in: scope.employeeIds } }] };

    const evaluations = await PerformanceEvaluation.find(finalFilter)
      .populate(populate)
      .sort({ year: -1, month: -1, composite: -1 });
    res.json(evaluations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/performance/employee/:employeeId — one employee's history
export const getEmployeeEvaluations = async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.employeeId).select(
      'name department departmentId'
    );
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    if (!(await canEvaluate(req, employee._id))) {
      return res.status(403).json({ message: 'Not authorized to view this employee' });
    }
    const evaluations = await PerformanceEvaluation.find({
      employeeId: employee._id,
    })
      .populate(populate)
      .sort({ year: -1, month: -1 });
    res.json(evaluations);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/performance — create or update (upsert) an employee's
// evaluation for a given month/year.
export const upsertEvaluation = async (req, res) => {
  try {
    const {
      employeeId,
      month,
      year,
      notes,
      punctualitySource,
    } = req.body;

    if (!employeeId) return res.status(400).json({ message: 'Select an employee.' });
    const m = Number(month);
    const y = Number(year);
    if (!m || m < 1 || m > 12 || !y) {
      return res.status(400).json({ message: 'A valid month and year are required.' });
    }

    const employee = await Employee.findById(employeeId).select(
      'name department departmentId'
    );
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    if (isSelf(req, employee._id)) {
      return res.status(403).json({ message: 'You cannot evaluate yourself.' });
    }
    if (!(await canEvaluate(req, employee._id))) {
      return res
        .status(403)
        .json({ message: 'You can only evaluate your own department.' });
    }

    const scores = {};
    for (const p of PILLARS) scores[p] = clampScore(req.body[p]);
    const composite =
      Math.round((PILLARS.reduce((s, p) => s + scores[p], 0) / PILLARS.length) * 10) / 10;

    const doc = await PerformanceEvaluation.findOneAndUpdate(
      { employeeId, month: m, year: y },
      {
        $set: {
          ...scores,
          composite,
          punctualitySource: punctualitySource === 'auto' ? 'auto' : 'manual',
          notes: notes ?? '',
          employeeName: employee.name || '',
          departmentId: employee.departmentId ?? null,
          department: employee.department || '',
          evaluatedBy: req.user?._id ?? null,
          evaluatorName: req.user?.name ?? '',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate(populate);

    res.status(201).json(doc);
  } catch (error) {
    // Duplicate-key (race on the unique index) → treat as a conflict.
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'An evaluation for this month already exists.' });
    }
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/performance/:id
export const deleteEvaluation = async (req, res) => {
  try {
    const evaluation = await PerformanceEvaluation.findById(req.params.id);
    if (!evaluation) return res.status(404).json({ message: 'Evaluation not found' });
    if (isSelf(req, evaluation.employeeId) || !(await canEvaluate(req, evaluation.employeeId))) {
      return res.status(403).json({ message: 'Not authorized to delete this evaluation' });
    }
    await evaluation.deleteOne();
    res.json({ message: 'Evaluation removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
