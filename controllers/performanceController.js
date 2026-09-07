import PerformanceEvaluation, { PILLARS } from '../models/PerformanceEvaluation.js';
import Employee from '../models/Employee.js';

// "HR / Admin (anyone)" tier — there is no dedicated `hr` role, so full-access
// roles stand in for HR. Department heads may evaluate only their own team.
const isAdmin = (u) => u?.role === 'admin' || u?.role === 'manager';
const canRead = (u) => isAdmin(u) || u?.isDepartmentHead === true;

const sameDept = (u, employee) =>
  u?.departmentId &&
  employee?.departmentId &&
  String(u.departmentId) === String(employee.departmentId);

const canEvaluate = (u, employee) =>
  isAdmin(u) || (u?.isDepartmentHead === true && sameDept(u, employee));

const clampScore = (v) => Math.max(0, Math.min(5, Number(v) || 0));

const populate = [
  { path: 'employeeId', select: 'name department departmentId artistRole profileImage status' },
  { path: 'evaluatedBy', select: 'name role' },
];

// @route GET /api/performance?month=&year=&employeeId=&departmentId=
export const getEvaluations = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'Not authorized to view evaluations' });
    }
    const { month, year, employeeId, departmentId } = req.query;
    const filter = {};
    if (month) filter.month = Number(month);
    if (year) filter.year = Number(year);
    if (employeeId) filter.employeeId = employeeId;

    // A department head is scoped to their own department; admins/managers see all.
    if (!isAdmin(req.user) && req.user?.isDepartmentHead) {
      filter.departmentId = req.user.departmentId ?? null;
    } else if (departmentId) {
      filter.departmentId = departmentId;
    }

    const evaluations = await PerformanceEvaluation.find(filter)
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
    if (!isAdmin(req.user) &&
        !(req.user?.isDepartmentHead && sameDept(req.user, employee))) {
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
    if (!canEvaluate(req.user, employee)) {
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
    const employee = await Employee.findById(evaluation.employeeId).select('departmentId');
    if (!canEvaluate(req.user, employee || {})) {
      return res.status(403).json({ message: 'Not authorized to delete this evaluation' });
    }
    await evaluation.deleteOne();
    res.json({ message: 'Evaluation removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
