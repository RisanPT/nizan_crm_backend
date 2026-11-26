import asyncHandler from 'express-async-handler';
import Course from '../models/Course.js';
import Enrollment from '../models/Enrollment.js';
import Employee from '../models/Employee.js';
import { getHrScope, scopeFilter, canManageEmployee, assertEmployeeInScope, isHrWide } from '../utils/hrDeptScope.js';
import { escapeRegex } from '../utils/escapeRegex.js';

// Department-head scoping (owner decision 2026-11-06): course and orientation
// PLAN catalogues are company master data (HR-wide only); enrolments and
// orientation assignments are scoped to the department head's own staff.
const HR_KEYS = ['lms'];
const assertHrWide = async (req, res) => {
  if (!(await isHrWide(req, HR_KEYS))) { res.status(403); throw new Error('Only HR can manage this'); }
};

const empPopulate = { path: 'employeeId', select: 'name department' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('lms') || perms.includes('staff');
};

// ── Courses ──────────────────────────────────────────────────────────────────
const getCourses = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.active = true;
  const rows = await Course.find(filter).sort({ createdAt: -1 }).lean();
  res.json(rows);
});

const createCourse = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to manage courses'); }
  await assertHrWide(req, res); // course catalogue is company master data
  const title = String(req.body.title || '').trim();
  if (!title) { res.status(400); throw new Error('Please add a course title'); }
  const row = await Course.create({
    title,
    description: String(req.body.description || '').trim(),
    category: req.body.category || 'skills',
    department: String(req.body.department || 'Technology & Systems (IT)').trim(),
    targetRole: String(req.body.targetRole || '').trim(),
    url: String(req.body.url || '').trim(),
    durationHours: Number(req.body.durationHours) || 0,
    active: req.body.active !== false,
    createdBy: req.user?._id || null,
  });
  res.status(201).json(row);
});

const updateCourse = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to manage courses'); }
  await assertHrWide(req, res); // course catalogue is company master data
  const row = await Course.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Course not found'); }
  const b = req.body;
  if (b.title !== undefined && String(b.title).trim()) row.title = String(b.title).trim();
  if (b.description !== undefined) row.description = String(b.description).trim();
  if (b.category !== undefined) row.category = b.category;
  if (b.department !== undefined) row.department = String(b.department).trim();
  if (b.targetRole !== undefined) row.targetRole = String(b.targetRole).trim();
  if (b.url !== undefined) row.url = String(b.url).trim();
  if (b.durationHours !== undefined) row.durationHours = Number(b.durationHours) || 0;
  if (b.active !== undefined) row.active = Boolean(b.active);
  await row.save();
  res.json(row);
});

const deleteCourse = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to manage courses'); }
  await assertHrWide(req, res); // course catalogue is company master data
  const inUse = await Enrollment.countDocuments({ courseId: req.params.id });
  if (inUse > 0) { res.status(409); throw new Error(`Cannot delete: ${inUse} enrolment(s) exist`); }
  const row = await Course.findByIdAndDelete(req.params.id);
  if (!row) {
    return res.json({ message: 'Course already removed', id: req.params.id });
  }
  res.json({ message: 'Course removed', id: req.params.id });
});

// ── Enrolments ───────────────────────────────────────────────────────────────
const getMyEnrollments = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.json([]);
  const rows = await Enrollment.find({ employeeId }).sort({ createdAt: -1 }).lean();
  res.json(rows);
});

const getEnrollments = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const filter = {};
  if (req.query.courseId) filter.courseId = req.query.courseId;
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  Object.assign(filter, await scopeFilter(req, HR_KEYS)); // dept heads: own department's staff
  const rows = await Enrollment.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(500);
  res.json(rows);
});

// @route POST /api/lms/enroll  { courseId, employeeId? }  (self or HR-assigned)
const enroll = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to enrol others'); }
    await assertEmployeeInScope(req, res, req.body.employeeId, HR_KEYS);
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }

  const course = await Course.findById(req.body.courseId);
  if (!course) { res.status(404); throw new Error('Course not found'); }
  const employee = await Employee.findById(employeeId).select('name');

  const existing = await Enrollment.findOne({ employeeId, courseId: course._id });
  if (existing) { res.status(409); throw new Error('Already enrolled in this course'); }

  const row = await Enrollment.create({
    employeeId,
    employeeName: employee?.name || '',
    courseId: course._id,
    courseTitle: course.title,
    status: 'enrolled',
    progress: 0,
  });
  res.status(201).json(row);
});

// @route PUT /api/lms/enrollments/:id  { progress, status }  (own or HR)
const updateEnrollment = asyncHandler(async (req, res) => {
  const row = await Enrollment.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Enrolment not found'); }
  const owns = String(row.employeeId) === String(req.user.employeeId || '');
  const managesIt = canManage(req.user) && (await canManageEmployee(req, row.employeeId, HR_KEYS));
  if (!owns && !managesIt) { res.status(403); throw new Error('Not allowed'); }
  // Only a manager in scope may mark an enrolment completed — never the
  // employee on their own record (HR-wide callers excepted).
  const mayComplete = managesIt && (!owns || (await isHrWide(req, HR_KEYS)));
  const wasCompleted = row.status === 'completed';

  if (req.body.progress !== undefined) {
    row.progress = Math.max(0, Math.min(100, Number(req.body.progress) || 0));
  }
  if (req.body.status !== undefined) row.status = req.body.status;
  // Derive status from progress unless explicitly set.
  if (req.body.status === undefined) {
    if (row.progress >= 100) row.status = 'completed';
    else if (row.progress > 0) row.status = 'in_progress';
  }
  if (row.status === 'completed' && !wasCompleted && !mayComplete) {
    res.status(403);
    throw new Error('Completion must be confirmed by your manager or HR');
  }
  if (row.status === 'completed') {
    row.progress = 100;
    row.completedOn = row.completedOn || new Date();
  } else {
    row.completedOn = null;
  }
  await row.save();
  res.json(row);
});

const deleteEnrollment = asyncHandler(async (req, res) => {
  const row = await Enrollment.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Enrolment not found'); }
  const owns = String(row.employeeId) === String(req.user.employeeId || '');
  if (!owns && !(canManage(req.user) && (await canManageEmployee(req, row.employeeId, HR_KEYS)))) {
    res.status(403); throw new Error('Not allowed');
  }
  await row.deleteOne();
  res.json({ message: 'Enrolment removed', id: req.params.id });
});

// ── Orientation Plans & 1-Week Job Role Syllabus (FR-3.2, FR-3.4) ────────────
import OrientationPlan from '../models/OrientationPlan.js';
import OrientationAssignment from '../models/OrientationAssignment.js';

// No seeded plans or courses (owner decision 2026-11-24): the old generic
// corporate set (DevOps, CTO-style roles, cloud courses) was re-created on every
// load and could not be deleted. HR creates the plans and courses it needs.

const getOrientationPlans = asyncHandler(async (req, res) => {
  const plans = await OrientationPlan.find({}).sort({ department: 1, roleTitle: 1 });
  res.json(plans);
});

const createOrientationPlan = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  await assertHrWide(req, res); // orientation plans are company master data
  const roleTitle = String(req.body.roleTitle || '').trim();
  const department = String(req.body.department || '').trim();
  if (!roleTitle || !department) { res.status(400); throw new Error('Role title and department required'); }

  const plan = await OrientationPlan.create({
    roleTitle,
    department,
    trainerName: req.body.trainerName || 'Department Lead',
    overview: req.body.overview || '',
    documentUrl: req.body.documentUrl || '',
    documentContent: req.body.documentContent || '',
    days: req.body.days || undefined,
    status: req.body.status || 'Active',
    createdBy: req.user?._id || null,
  });
  res.status(201).json(plan);
});

const updateOrientationPlan = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  await assertHrWide(req, res); // orientation plans are company master data
  const plan = await OrientationPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Plan not found'); }
  const b = req.body;
  if (b.roleTitle !== undefined) plan.roleTitle = String(b.roleTitle).trim();
  if (b.department !== undefined) plan.department = String(b.department).trim();
  if (b.trainerName !== undefined) plan.trainerName = String(b.trainerName).trim();
  if (b.overview !== undefined) plan.overview = String(b.overview).trim();
  if (b.documentUrl !== undefined) plan.documentUrl = String(b.documentUrl).trim();
  if (b.documentContent !== undefined) plan.documentContent = String(b.documentContent).trim();
  if (b.days !== undefined && Array.isArray(b.days)) plan.days = b.days;
  if (b.status !== undefined) plan.status = b.status;
  await plan.save();
  res.json(plan);
});

const deleteOrientationPlan = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  await assertHrWide(req, res); // orientation plans are company master data
  const plan = await OrientationPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Plan not found'); }
  await plan.deleteOne();
  res.json({ message: 'Orientation plan deleted', id: req.params.id });
});

const getActiveOrientations = asyncHandler(async (req, res) => {
  // HR sees every orientation; anyone else only their own. (The old demo
  // seeding of sample trainees on every load has been removed.)
  // Department heads see their own department's (plus their own).
  if (canManage(req.user)) {
    const scope = await getHrScope(req, HR_KEYS);
    if (scope.wide) return res.json(await OrientationAssignment.find({}).sort({ createdAt: -1 }));
    const or = [await scopeFilter(req, HR_KEYS)];
    if (req.user?.employeeId) or.push({ employeeId: req.user.employeeId });
    return res.json(await OrientationAssignment.find({ $or: or }).sort({ createdAt: -1 }));
  }
  if (!req.user?.employeeId) return res.json([]);
  const list = await OrientationAssignment.find({ employeeId: req.user.employeeId }).sort({ createdAt: -1 });
  res.json(list);
});

const assignOrientation = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const { employeeId, planId } = req.body;
  if (!employeeId) { res.status(400); throw new Error('Employee required'); }
  await assertEmployeeInScope(req, res, employeeId, HR_KEYS);

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  // HR picks the plan. With none chosen, the department's plan is used only
  // when it is the one plan for that department; otherwise ask HR to choose
  // (the old "any plan in the department" guess could assign the wrong syllabus).
  let plan = null;
  if (planId) {
    plan = await OrientationPlan.findById(planId);
    if (!plan) { res.status(404); throw new Error('Orientation plan not found'); }
  } else {
    const dept = String(employee.department || '').trim();
    const deptPlans = dept
      ? await OrientationPlan.find({ department: new RegExp(`^${escapeRegex(dept)}$`, 'i') }).limit(2)
      : [];
    if (deptPlans.length > 1) {
      res.status(400);
      throw new Error(`There are several orientation plans for ${dept}. Please choose the plan to assign.`);
    }
    plan = deptPlans[0] || null;
  }

  if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
    res.status(400);
    throw new Error('No orientation plan for this role or department yet. Create one under Orientation Plans first.');
  }
  const daysTemplate = plan.days;
  const days = daysTemplate.map((d) => ({
    dayNumber: d.dayNumber,
    title: d.title,
    topics: d.topics,
    signedOff: false,
    status: d.dayNumber === 1 ? 'In progress' : 'Upcoming',
  }));

  const assignment = await OrientationAssignment.create({
    employeeId: employee._id,
    employeeName: employee.name,
    roleTitle: plan?.roleTitle || employee.role || 'Staff',
    department: plan?.department || employee.department || 'General',
    // HR's chosen trainer wins; the plan's default trainer is the fallback.
    trainerName: String(req.body.trainerName || '').trim() || plan?.trainerName || 'Department Lead',
    planId: plan?._id || null,
    currentDay: 1,
    totalDays: days.length,
    status: 'On track',
    days,
    createdBy: req.user?._id || null,
  });

  res.status(201).json(assignment);
});

const updateOrientationProgress = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const assignment = await OrientationAssignment.findById(req.params.id);
  if (!assignment) { res.status(404); throw new Error('Orientation not found'); }
  await assertEmployeeInScope(req, res, assignment.employeeId, HR_KEYS);

  const b = req.body;
  if (b.currentDay !== undefined) assignment.currentDay = Number(b.currentDay);
  if (b.status !== undefined) assignment.status = b.status;
  if (Array.isArray(b.days)) assignment.days = b.days;

  // Sign off a specific day
  if (b.signOffDay !== undefined) {
    const dayNum = Number(b.signOffDay);
    const day = assignment.days.find((d) => d.dayNumber === dayNum);
    if (day) {
      day.signedOff = b.signedOff !== false;
      day.signedOffBy = req.user.name || 'HR Lead';
      day.signedOffAt = new Date();
      day.status = day.signedOff ? 'Signed' : 'In progress';
    }
  }

  // Status follows the sign-offs: Completed once every day is signed, and
  // back on track if a day is un-signed later.
  const allDays = Array.isArray(assignment.days) ? assignment.days : [];
  const allSigned = allDays.length > 0 && allDays.every((d) => d.signedOff);
  if (allSigned) assignment.status = 'Completed';
  else if (assignment.status === 'Completed') assignment.status = 'On track';

  await assignment.save();
  res.json(assignment);
});

export {
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  getMyEnrollments,
  getEnrollments,
  enroll,
  updateEnrollment,
  deleteEnrollment,
  getOrientationPlans,
  createOrientationPlan,
  updateOrientationPlan,
  deleteOrientationPlan,
  getActiveOrientations,
  assignOrientation,
  updateOrientationProgress,
};
