import asyncHandler from 'express-async-handler';
import JobPost from '../models/JobPost.js';
import Candidate from '../models/Candidate.js';
import Offer from '../models/Offer.js';
import Employee from '../models/Employee.js';
import Onboarding, { DEFAULT_ONBOARDING_TASKS } from '../models/Onboarding.js';
import JobRole from '../models/JobRole.js';
import HiringPlan from '../models/HiringPlan.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import Department from '../models/Department.js';
import { isAdminOnlyRole } from '../utils/userAccess.js';
import { getHrScope, deptNameFilter, isHrWide } from '../utils/hrDeptScope.js';
import { needsLeadership } from '../utils/decisionRules.js';
import { escalate, getPolicy, hasLeadership, supersedeFor, withdrawFor } from '../services/decisions.js';

// Department-head scoping (owner decision 2026-11-06): HR-wide callers see and
// manage everything; a department head only their own department's job posts,
// hiring plans, offers and the candidates on those job posts.
const HR_KEYS = ['recruitment'];
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sameDept = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

const deptInScope = async (req, dept) => {
  const s = await getHrScope(req, HR_KEYS);
  if (s.wide) return true;
  const d = String(dept || '').trim();
  return !!d && s.deptNames.some((n) => sameDept(n, d));
};

const assertDeptInScope = async (req, res, dept) => {
  if (!(await deptInScope(req, dept))) {
    res.status(403);
    throw new Error('This department is not in your scope');
  }
};

// null = HR-wide (no restriction); otherwise the job post ids in the caller's departments.
const scopedJobPostIds = async (req) => {
  const s = await getHrScope(req, HR_KEYS);
  if (s.wide) return null;
  const rows = await JobPost.find(await deptNameFilter(req, HR_KEYS)).select('_id').lean();
  return rows.map((r) => String(r._id));
};

// Candidates belong to a department through their job post.
const assertJobPostInScope = async (req, res, jobPostId) => {
  const ids = await scopedJobPostIds(req);
  if (ids === null) return;
  if (!jobPostId || !ids.includes(String(jobPostId))) {
    res.status(403);
    throw new Error('This job post is not in your department');
  }
};

// Company master data / secrets — HR-wide callers only.
const assertHrWide = async (req, res) => {
  if (!(await isHrWide(req, HR_KEYS))) {
    res.status(403);
    throw new Error('Only HR can manage this');
  }
};

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('recruitment') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage recruitment');
  }
};

// ── Job posts ────────────────────────────────────────────────────────────────
const getJobPosts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  // Department heads see only their department's posts; everyone else unchanged.
  if (canManage(req.user)) Object.assign(filter, await deptNameFilter(req, HR_KEYS));
  const posts = await JobPost.find(filter)
    .populate('designationId', 'name')
    .sort({ createdAt: -1 })
    .lean();
  // Attach a live candidate count per post for the pipeline header.
  const counts = await Candidate.aggregate([
    { $match: { jobPostId: { $ne: null } } },
    { $group: { _id: '$jobPostId', n: { $sum: 1 } } },
  ]);
  const byPost = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  res.json(posts.map((p) => ({ ...p, candidateCount: byPost[String(p._id)] || 0 })));
});

const createJobPost = asyncHandler(async (req, res) => {
  guard(req, res);
  const title = String(req.body.title || '').trim();
  if (!title) { res.status(400); throw new Error('Please provide a job title'); }
  let department = String(req.body.department || '').trim();
  // A department head may only post for their own department (defaulted when blank).
  const scope = await getHrScope(req, HR_KEYS);
  if (!scope.wide && !department && scope.deptNames.length) department = scope.deptNames[0];
  await assertDeptInScope(req, res, department);
  const post = await JobPost.create({
    title,
    department,
    designationId: req.body.designationId || null,
    location: String(req.body.location || '').trim(),
    type: req.body.type || 'full-time',
    openings: Number(req.body.openings) || 1,
    description: String(req.body.description || '').trim(),
    status: req.body.status || 'open',
    createdBy: req.user?._id || null,
  });
  res.status(201).json(post);
});

const updateJobPost = asyncHandler(async (req, res) => {
  guard(req, res);
  const post = await JobPost.findById(req.params.id);
  if (!post) { res.status(404); throw new Error('Job post not found'); }
  const b = req.body;
  // Both the current and any new department must be in the caller's scope.
  await assertDeptInScope(req, res, post.department);
  if (b.department !== undefined) await assertDeptInScope(req, res, b.department);
  if (b.title !== undefined && String(b.title).trim()) post.title = String(b.title).trim();
  if (b.department !== undefined) post.department = String(b.department).trim();
  if (b.designationId !== undefined) post.designationId = b.designationId || null;
  if (b.location !== undefined) post.location = String(b.location).trim();
  if (b.type !== undefined) post.type = b.type;
  if (b.openings !== undefined) post.openings = Number(b.openings) || 1;
  if (b.description !== undefined) post.description = String(b.description).trim();
  if (b.status !== undefined) {
    post.status = b.status;
    if (b.status === 'closed' && !post.closedOn) post.closedOn = new Date();
  }
  await post.save();
  res.json(post);
});

const deleteJobPost = asyncHandler(async (req, res) => {
  guard(req, res);
  const existing = await JobPost.findById(req.params.id).select('department').lean();
  if (existing) await assertDeptInScope(req, res, existing.department);
  const inUse = await Candidate.countDocuments({ jobPostId: req.params.id });
  if (inUse > 0) {
    res.status(409);
    throw new Error(`Cannot delete: ${inUse} candidate(s) are linked to this post`);
  }
  const post = await JobPost.findByIdAndDelete(req.params.id);
  if (!post) { res.status(404); throw new Error('Job post not found'); }
  res.json({ message: 'Job post removed', id: req.params.id });
});

// ── Candidates ───────────────────────────────────────────────────────────────
const getCandidates = asyncHandler(async (req, res) => {
  guard(req, res);
  const filter = {};
  if (req.query.jobPostId) filter.jobPostId = req.query.jobPostId;
  if (req.query.stage && req.query.stage !== 'all') filter.stage = req.query.stage;
  // Department heads: only candidates on their department's job posts.
  const allowedPosts = await scopedJobPostIds(req);
  if (allowedPosts !== null) {
    filter.jobPostId = req.query.jobPostId
      ? (allowedPosts.includes(String(req.query.jobPostId)) ? req.query.jobPostId : { $in: [] })
      : { $in: allowedPosts };
  }
  const rows = await Candidate.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  res.json(rows);
});

const createCandidate = asyncHandler(async (req, res) => {
  guard(req, res);
  const name = String(req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide the candidate name'); }
  await assertJobPostInScope(req, res, req.body.jobPostId);
  let jobTitle = String(req.body.jobTitle || '').trim();
  if (req.body.jobPostId) {
    const post = await JobPost.findById(req.body.jobPostId).select('title').lean();
    if (post?.title) jobTitle = post.title;
  }
  const cand = await Candidate.create({
    name,
    email: String(req.body.email || '').trim(),
    phone: String(req.body.phone || '').trim(),
    jobPostId: req.body.jobPostId || null,
    jobTitle,
    source: req.body.source || 'website',
    referrer: String(req.body.referrer || '').trim(),
    stage: req.body.stage || 'applied',
    rating: Number(req.body.rating) || 0,
    resumeUrl: String(req.body.resumeUrl || '').trim(),
    notes: String(req.body.notes || '').trim(),
    createdBy: req.user?._id || null,
  });
  res.status(201).json(cand);
});

const bulkImportCandidates = asyncHandler(async (req, res) => {
  guard(req, res);
  const candidatesList = Array.isArray(req.body.candidates) ? req.body.candidates : [];
  if (candidatesList.length === 0) {
    res.status(400);
    throw new Error('Please provide a non-empty list of candidates to import');
  }
  await assertJobPostInScope(req, res, req.body.jobPostId);

  let jobPost = null;
  if (req.body.jobPostId) {
    jobPost = await JobPost.findById(req.body.jobPostId).select('title').lean();
  }
  const defaultJobTitle = jobPost?.title || String(req.body.jobTitle || 'Applicant').trim();
  const defaultSource = String(req.body.source || 'meta').toLowerCase().trim();
  const campaignName = String(req.body.campaignName || '').trim();

  // Deduplicate against existing candidates by email/phone
  const emails = candidatesList.map((c) => String(c.email || '').trim().toLowerCase()).filter(Boolean);
  const phones = candidatesList.map((c) => String(c.phone || '').trim()).filter(Boolean);

  const existing = await Candidate.find({
    $or: [
      { email: { $in: emails, $ne: '' } },
      { phone: { $in: phones, $ne: '' } },
    ],
  }).select('email phone').lean();

  const existingEmails = new Set(existing.map((e) => e.email?.toLowerCase()).filter(Boolean));
  const existingPhones = new Set(existing.map((e) => e.phone).filter(Boolean));

  const toInsert = [];
  let duplicatesCount = 0;

  for (const item of candidatesList) {
    const name = String(item.name || item.fullName || '').trim();
    if (!name) continue;

    const email = String(item.email || '').trim().toLowerCase();
    const phone = String(item.phone || item.mobile || '').trim();

    if ((email && existingEmails.has(email)) || (phone && existingPhones.has(phone))) {
      duplicatesCount++;
      continue;
    }

    if (email) existingEmails.add(email);
    if (phone) existingPhones.add(phone);

    toInsert.push({
      name,
      email,
      phone,
      jobPostId: jobPost?._id || req.body.jobPostId || null,
      jobTitle: String(item.jobTitle || defaultJobTitle).trim(),
      source: item.source || defaultSource,
      referrer: String(item.referrer || campaignName || 'Ad Campaign / Bulk CV Ingestion').trim(),
      stage: (item.stage && ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'].includes(item.stage))
        ? item.stage
        : (req.body.stage || 'applied'),
      rating: Number(item.rating) || 0,
      resumeUrl: String(item.resumeUrl || item.cvUrl || '').trim(),
      notes: [
        item.location ? `Location: ${item.location}` : '',
        item.experience ? `Experience: ${item.experience}` : '',
        item.status ? `Interview Status: ${item.status}` : '',
        item.linkedinUrl ? `LinkedIn: ${item.linkedinUrl}` : '',
        item.notes || ''
      ].filter(Boolean).join(' | '),
      createdBy: req.user?._id || null,
    });
  }

  let insertedDocs = [];
  if (toInsert.length > 0) {
    insertedDocs = await Candidate.insertMany(toInsert);

    await notifyRecruitmentTeam({
      title: `Bulk CV Import: ${insertedDocs.length} Candidates`,
      body: `Imported ${insertedDocs.length} new applicants from ${defaultSource.toUpperCase()} into ${defaultJobTitle}`,
      link: '/hr/recruitment',
    });
  }

  res.status(201).json({
    success: true,
    message: `Successfully imported ${insertedDocs.length} candidates (${duplicatesCount} duplicates skipped)`,
    importedCount: insertedDocs.length,
    duplicatesCount,
    totalProcessed: candidatesList.length,
    candidates: insertedDocs.slice(0, 10).map((c) => ({ id: c._id, name: c.name, jobTitle: c.jobTitle })),
  });
});

export const linkHiredCandidateToOnboarding = async (candidate, userId = null) => {
  if (!candidate) return null;
  // Check if onboarding already exists for this candidate
  let onboarding = await Onboarding.findOne({
    $or: [
      { candidateId: candidate._id },
      { employeeName: candidate.name }
    ]
  });
  if (onboarding) return onboarding;

  // Find offer if any
  const offer = await Offer.findOne({ candidateId: candidate._id }).sort({ createdAt: -1 });

  // Determine role & department
  let role = String(offer?.designation || candidate.jobTitle || '').trim();
  let department = offer?.department || '';
  if (candidate.jobPostId && (!department || !role)) {
    const post = await JobPost.findById(candidate.jobPostId).select('department title').lean();
    if (!department && post?.department) department = post.department;
    if (!role && post?.title) role = post.title;
  }
  if (!role) role = 'Staff';
  // The HRMS job role with this title (HR-owned list). It supplies the real
  // department and is stored on the employee so the login gets its CRM role.
  const jobRole = await findJobRoleByTitle(role);
  if (!department && jobRole?.dept) department = jobRole.dept;
  if (!department) department = 'General';
  // Artist / driver CRM roles also drive the employee's artistRole (artist
  // scoping, driver screens). Other roles stay plain staff.
  const crmKey = String(jobRole?.crmRoleKey || '').toLowerCase();
  const fieldRole = crmKey === 'artist' || crmKey === 'driver' ? crmKey : null;

  // Find or create employee
  let employee = null;
  if (offer?.employeeId) {
    employee = await Employee.findById(offer.employeeId);
  }
  // Link an existing employee by email only (case-insensitive). The old
  // name-only fallback could attach a hire to an unrelated namesake.
  const candEmail = String(candidate.email || '').trim();
  if (!employee && candEmail) {
    employee = await Employee.findOne({ email: new RegExp(`^${escRx(candEmail)}$`, 'i') });
  }

  if (!employee) {
    employee = await Employee.create({
      name: candidate.name || 'New hire',
      email: (candidate.email || '').toLowerCase().trim(),
      phone: candidate.phone || '',
      type: 'full-time',
      artistRole: fieldRole || 'staff',
      specialization: role,
      status: 'active',
      role,
      department,
      departmentId: jobRole && sameDept(jobRole.dept, department) ? jobRole.departmentId || null : null,
      jobRoleId: jobRole?._id || null,
      category: fieldRole ? 'operations' : 'administrative',
      salaryType: 'fixed_monthly',
      baseSalary: offer?.salary || 0,
    });
  } else if (jobRole && !employee.jobRoleId) {
    // An existing employee (matched by email) only gains the job-role link;
    // their other details are left as HR set them.
    // updateOne, so validation of older employee fields can't block the hire.
    await Employee.updateOne({ _id: employee._id }, { $set: { jobRoleId: jobRole._id } });
    employee.jobRoleId = jobRole._id;
  }

  // Update offer if present
  if (offer) {
    offer.status = 'accepted';
    offer.employeeId = employee._id;
    if (!offer.decidedAt) offer.decidedAt = new Date();
    await offer.save();
  }

  // Set joining date: offer's joiningDate or 2 weeks from now
  const joiningDate = offer?.joiningDate || new Date(Date.now() + 14 * 86400000);

  const tasks = DEFAULT_ONBOARDING_TASKS.map((t) => ({
    title: t,
    done: false, // nothing is ticked until HR actually does it
    owner: 'HR Team',
    note: '',
  }));

  const documents = [
    { name: 'Signed offer letter', owner: employee.name, required: true, status: 'Pending' },
    { name: 'Aadhaar & PAN', owner: employee.name, required: true, status: 'Pending' },
    { name: 'Bank account proof', owner: employee.name, required: true, status: 'Pending' },
    { name: 'Previous experience letter', owner: employee.name, required: false, status: 'Pending' },
    { name: 'Education certificates', owner: employee.name, required: true, status: 'Pending' },
  ];

  onboarding = await Onboarding.create({
    employeeId: employee._id,
    employeeName: employee.name,
    department: employee.department || department,
    role: employee.role || role,
    joiningDate,
    candidateId: candidate._id,
    offerId: offer?._id || null,
    tasks,
    documents,
    createdBy: userId,
  });

  return onboarding;
};

const updateCandidate = asyncHandler(async (req, res) => {
  guard(req, res);
  const cand = await Candidate.findById(req.params.id);
  if (!cand) { res.status(404); throw new Error('Candidate not found'); }
  const b = req.body;
  // Covers the hire flow (stage → hired) too: candidate's job post must be in scope.
  await assertJobPostInScope(req, res, cand.jobPostId);
  if (b.jobPostId !== undefined) await assertJobPostInScope(req, res, b.jobPostId);
  if (b.name !== undefined && String(b.name).trim()) cand.name = String(b.name).trim();
  if (b.email !== undefined) cand.email = String(b.email).trim();
  if (b.phone !== undefined) cand.phone = String(b.phone).trim();
  if (b.jobPostId !== undefined) {
    cand.jobPostId = b.jobPostId || null;
    if (b.jobPostId) {
      const post = await JobPost.findById(b.jobPostId).select('title').lean();
      if (post?.title) cand.jobTitle = post.title;
    }
  }
  if (b.jobTitle !== undefined && String(b.jobTitle).trim()) cand.jobTitle = String(b.jobTitle).trim();
  if (b.referrer !== undefined) cand.referrer = String(b.referrer).trim();
  if (b.stage !== undefined) {
    cand.stage = b.stage;
    if (b.stage === 'hired') {
      await linkHiredCandidateToOnboarding(cand, req.user?._id);
    }
  }
  if (b.source !== undefined) cand.source = b.source;
  if (b.rating !== undefined) cand.rating = Number(b.rating) || 0;
  if (b.resumeUrl !== undefined) cand.resumeUrl = String(b.resumeUrl).trim();
  if (b.notes !== undefined) cand.notes = String(b.notes).trim();
  await cand.save();
  res.json(cand);
});

const deleteCandidate = asyncHandler(async (req, res) => {
  guard(req, res);
  const cand = await Candidate.findById(req.params.id);
  if (!cand) { res.status(404); throw new Error('Candidate not found'); }
  await assertJobPostInScope(req, res, cand.jobPostId);

  const deleteLinked = req.query.deleteLinkedEmployee === 'true' || req.body?.deleteLinkedEmployee === true;

  // Clean up offers for this candidate
  const offers = await Offer.find({ candidateId: cand._id });
  const linkedEmployeeIds = [];
  for (const offer of offers) {
    if (deleteLinked && offer.employeeId) {
      linkedEmployeeIds.push(offer.employeeId);
      await Employee.findByIdAndDelete(offer.employeeId);
    }
  }

  if (deleteLinked) {
    // Only this candidate's own onboardings (by candidateId / linked employee),
    // never by name — a name match could wipe another person's onboarding.
    const or = [{ candidateId: cand._id }];
    if (linkedEmployeeIds.length) or.push({ employeeId: { $in: linkedEmployeeIds } });
    await Onboarding.deleteMany({ $or: or });
  }

  await Offer.deleteMany({ candidateId: cand._id });
  await Candidate.findByIdAndDelete(req.params.id);

  res.json({ message: 'Candidate removed', id: req.params.id });
});

const deleteOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const offer = await Offer.findById(req.params.id);
  if (!offer) { res.status(404); throw new Error('Offer not found'); }
  await assertDeptInScope(req, res, offer.department);

  const deleteLinked = req.query.deleteLinkedEmployee === 'true' || req.body?.deleteLinkedEmployee === true;
  if (deleteLinked && offer.employeeId) {
    await Employee.findByIdAndDelete(offer.employeeId);
    await Onboarding.deleteMany({
      $or: [
        { candidateId: offer.candidateId },
        { employeeId: offer.employeeId },
      ],
    });
  }

  // If candidate was in 'offer' or 'hired' stage, revert back to 'interview'
  if (offer.candidateId) {
    const cand = await Candidate.findById(offer.candidateId);
    if (cand && (cand.stage === 'offer' || cand.stage === 'hired')) {
      cand.stage = 'interview';
      await cand.save();
    }
  }

  await Offer.findByIdAndDelete(req.params.id);
  res.json({ message: 'Offer deleted successfully', id: req.params.id });
});

// ── Offers ───────────────────────────────────────────────────────────────────
const getOffers = asyncHandler(async (req, res) => {
  guard(req, res);
  const filter = {};
  if (req.query.candidateId) filter.candidateId = req.query.candidateId;
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  Object.assign(filter, await deptNameFilter(req, HR_KEYS)); // dept heads: own department only
  const rows = await Offer.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  res.json(rows);
});

const createOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const candidateId = String(req.body.candidateId || '').trim();
  if (!candidateId) { res.status(400); throw new Error('A candidate is required'); }
  const cand = await Candidate.findById(candidateId);
  if (!cand) { res.status(404); throw new Error('Candidate not found'); }
  await assertJobPostInScope(req, res, cand.jobPostId);

  let department = String(req.body.department || '').trim();
  if (!department && cand.jobPostId) {
    const post = await JobPost.findById(cand.jobPostId).select('department').lean();
    if (post?.department) department = post.department;
  }
  if (!department && (req.body.designation || cand.jobTitle)) {
    const roleTitle = String(req.body.designation || cand.jobTitle).trim();
    const role = await findJobRoleByTitle(roleTitle);
    if (role?.dept) department = role.dept;
  }
  // A department head may only raise offers for their own department.
  await assertDeptInScope(req, res, department);

  const offer = await Offer.create({
    candidateId: cand._id,
    candidateName: cand.name,
    jobPostId: cand.jobPostId || null,
    designation: String(req.body.designation || cand.jobTitle || '').trim(),
    designationId: req.body.designationId || null,
    department,
    salary: Number(req.body.salary) || 0,
    basicSalary: Number(req.body.basicSalary) || 0,
    hra: Number(req.body.hra) || 0,
    incentive: Number(req.body.incentive) || 0,
    incentiveNote: String(req.body.incentiveNote || '').trim(),
    reportingTo: String(req.body.reportingTo || 'HR Manager').trim(),
    probationMonths: Number(req.body.probationMonths) || 3,
    responsibilities: Array.isArray(req.body.responsibilities) ? req.body.responsibilities : [],
    joiningDate: req.body.joiningDate ? new Date(req.body.joiningDate) : null,
    status: req.body.status || 'draft',
    letterUrl: String(req.body.letterUrl || '').trim(),
    notes: String(req.body.notes || '').trim(),
    createdBy: req.user?._id || null,
  });
  // Advance the candidate to the offer stage.
  if (cand.stage !== 'hired') {
    cand.stage = 'offer';
    await cand.save();
  }
  res.status(201).json(offer);
});

const updateOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const offer = await Offer.findById(req.params.id);
  if (!offer) { res.status(404); throw new Error('Offer not found'); }
  if (['accepted', 'declined'].includes(offer.status)) {
    res.status(409);
    throw new Error('A decided offer can no longer be edited');
  }
  const b = req.body;
  await assertDeptInScope(req, res, offer.department);
  if (b.department !== undefined) await assertDeptInScope(req, res, b.department);
  if (b.designation !== undefined) offer.designation = String(b.designation).trim();
  if (b.designationId !== undefined) offer.designationId = b.designationId || null;
  if (b.department !== undefined) offer.department = String(b.department).trim();
  if (b.salary !== undefined) offer.salary = Number(b.salary) || 0;
  if (b.basicSalary !== undefined) offer.basicSalary = Number(b.basicSalary) || 0;
  if (b.hra !== undefined) offer.hra = Number(b.hra) || 0;
  if (b.incentive !== undefined) offer.incentive = Number(b.incentive) || 0;
  if (b.incentiveNote !== undefined) offer.incentiveNote = String(b.incentiveNote).trim();
  if (b.reportingTo !== undefined) offer.reportingTo = String(b.reportingTo).trim();
  if (b.probationMonths !== undefined) offer.probationMonths = Number(b.probationMonths) || 3;
  if (b.responsibilities !== undefined && Array.isArray(b.responsibilities)) offer.responsibilities = b.responsibilities;
  if (b.joiningDate !== undefined) offer.joiningDate = b.joiningDate ? new Date(b.joiningDate) : null;
  if (b.status !== undefined) offer.status = b.status;
  if (b.letterUrl !== undefined) offer.letterUrl = String(b.letterUrl).trim();
  if (b.notes !== undefined) offer.notes = String(b.notes).trim();
  await offer.save();
  res.json(offer);
});

// @route POST /api/recruitment/offers/:id/accept
// Creates the Employee (probation/active), links everything and kicks off
// onboarding with the default checklist.
const acceptOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const offer = await Offer.findById(req.params.id);
  if (!offer) { res.status(404); throw new Error('Offer not found'); }
  if (offer.status === 'accepted' && offer.employeeId) {
    res.status(409);
    throw new Error('This offer is already accepted');
  }
  await assertDeptInScope(req, res, offer.department);

  const cand = await Candidate.findById(offer.candidateId);
  // Hire flow: the candidate's job post must be in the caller's scope.
  await assertJobPostInScope(req, res, cand?.jobPostId || offer.jobPostId);
  if (cand) {
    cand.stage = 'hired';
    await cand.save();
  }

  const onboarding = await linkHiredCandidateToOnboarding(
    cand || { _id: offer.candidateId, name: offer.candidateName, jobTitle: offer.designation },
    req.user?._id
  );

  const updatedOffer = await Offer.findById(req.params.id);
  res.status(201).json({
    offer: updatedOffer,
    employeeId: String(onboarding?.employeeId || updatedOffer?.employeeId || ''),
    onboardingId: String(onboarding?._id || '')
  });
});

// @route POST /api/recruitment/offers/:id/decline
const declineOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const offer = await Offer.findById(req.params.id);
  if (!offer) { res.status(404); throw new Error('Offer not found'); }
  await assertDeptInScope(req, res, offer.department);
  offer.status = 'declined';
  offer.decidedAt = new Date();
  await offer.save();
  const cand = await Candidate.findById(offer.candidateId);
  if (cand && cand.stage === 'offer') {
    cand.stage = 'rejected';
    await cand.save();
  }
  res.json(offer);
});

// ── Job Roles & Organizational Hierarchy (FR-1.1 - FR-1.3) ───────────────────
// Job roles are HR-owned master data (owner decision 2026-11-24): there are no
// seeded defaults; HR adds the roles that exist in the office. Only `admin` and
// `hr` logins may create, edit or delete them (same rule as the leave desk).
// Each role sits in a real department (Departments master) and may name the CRM
// login role (Settings -> Roles key) its hires get.
const JOB_ROLE_MANAGERS = ['admin', 'hr'];
const isJobRoleManager = (user) => JOB_ROLE_MANAGERS.includes(String(user?.role || '').trim().toLowerCase());
const assertJobRoleManager = (req, res) => {
  if (!isJobRoleManager(req.user)) {
    res.status(403);
    throw new Error('Only HR or an administrator can manage job roles');
  }
};

// The active job role with this exact title (case-insensitive), or null.
const findJobRoleByTitle = async (title) => {
  const t = String(title || '').trim();
  if (!t) return null;
  return JobRole.findOne({ active: true, designation: new RegExp(`^${escRx(t)}$`, 'i') }).lean();
};

// Department from the master: by id, else by name. 400 when neither resolves.
const resolveJobRoleDepartment = async (res, departmentId, deptName) => {
  let dep = null;
  if (departmentId) dep = await Department.findById(departmentId).select('name active').lean();
  else if (String(deptName || '').trim()) {
    dep = await Department.findOne({ name: new RegExp(`^${escRx(String(deptName).trim())}$`, 'i') })
      .select('name active')
      .lean();
  }
  if (!dep || dep.active === false) {
    res.status(400);
    throw new Error('Please choose a department from the Departments list');
  }
  return { departmentId: dep._id, dept: dep.name };
};

// '' (no CRM role) or a known Settings role key. Only an admin may link the
// admin-only roles (admin / manager / ceo), matching who may grant them at login.
const resolveCrmRoleKey = async (req, res, raw) => {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return '';
  const role = await Role.findOne({ key }).select('key active').lean();
  if (!role || role.active === false) {
    res.status(400);
    throw new Error(`Unknown CRM role "${key}"`);
  }
  if (isAdminOnlyRole(key) && String(req.user?.role || '').trim().toLowerCase() !== 'admin') {
    res.status(403);
    throw new Error(`Only an administrator can link the "${key}" login role`);
  }
  return key;
};

const assertUniqueDesignation = async (res, designation, exceptId = null) => {
  const filter = { active: true, designation: new RegExp(`^${escRx(designation)}$`, 'i') };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await JobRole.exists(filter)) {
    res.status(409);
    throw new Error(`A job role named "${designation}" already exists`);
  }
};

const getJobRoles = asyncHandler(async (req, res) => {
  // No auto-seed: HR creates its own roles.
  const roles = await JobRole.find({ active: true }).sort({ tier: 1, designation: 1 }).lean();
  res.json(roles);
});

const createJobRole = asyncHandler(async (req, res) => {
  assertJobRoleManager(req, res);
  const designation = String(req.body.designation || '').trim();
  if (!designation) { res.status(400); throw new Error('Please provide a designation title'); }
  await assertUniqueDesignation(res, designation);
  const { departmentId, dept } = await resolveJobRoleDepartment(res, req.body.departmentId, req.body.dept);
  const crmRoleKey = await resolveCrmRoleKey(req, res, req.body.crmRoleKey);
  const role = await JobRole.create({
    roleCode: req.body.roleCode || `role-${Date.now()}`,
    designation,
    shortTitle: req.body.shortTitle || designation,
    dept,
    departmentId,
    crmRoleKey,
    band: req.body.band || 'L3',
    tier: Number(req.body.tier) || 5,
    parentId: req.body.parentId || null,
    reportsTo: req.body.reportsTo || '',
    team: req.body.team || '',
    headcount: Number(req.body.headcount) || 1,
    purpose: req.body.purpose || '',
    responsibilities: Array.isArray(req.body.responsibilities) ? req.body.responsibilities : [],
    deliverables: req.body.deliverables || '',
    exp: req.body.exp || '2-4 yrs',
    qual: req.body.qual || '',
    skills: Array.isArray(req.body.skills) ? req.body.skills : [],
    competencies: Array.isArray(req.body.competencies) ? req.body.competencies : [],
    createdBy: req.user?._id || null,
  });
  res.status(201).json(role);
});

const updateJobRole = asyncHandler(async (req, res) => {
  assertJobRoleManager(req, res);
  const role = await JobRole.findById(req.params.id);
  if (!role || role.active === false) { res.status(404); throw new Error('Job role not found'); }
  const b = req.body;
  if (b.designation !== undefined) {
    const designation = String(b.designation).trim();
    if (!designation) { res.status(400); throw new Error('Please provide a designation title'); }
    await assertUniqueDesignation(res, designation, role._id);
    role.designation = designation;
  }
  if (b.departmentId !== undefined || b.dept !== undefined) {
    const d = await resolveJobRoleDepartment(res, b.departmentId, b.dept);
    role.departmentId = d.departmentId;
    role.dept = d.dept;
  }
  if (b.crmRoleKey !== undefined) role.crmRoleKey = await resolveCrmRoleKey(req, res, b.crmRoleKey);
  if (b.shortTitle !== undefined) role.shortTitle = String(b.shortTitle).trim();
  if (b.band !== undefined) role.band = b.band;
  if (b.tier !== undefined) role.tier = Number(b.tier) || 5;
  if (b.parentId !== undefined) role.parentId = b.parentId || null;
  if (b.reportsTo !== undefined) role.reportsTo = b.reportsTo || '';
  if (b.team !== undefined) role.team = b.team || '';
  if (b.headcount !== undefined) role.headcount = Number(b.headcount) || 1;
  if (b.purpose !== undefined) role.purpose = b.purpose;
  if (b.responsibilities !== undefined) role.responsibilities = b.responsibilities;
  if (b.deliverables !== undefined) role.deliverables = b.deliverables;
  if (b.exp !== undefined) role.exp = b.exp;
  if (b.qual !== undefined) role.qual = b.qual;
  if (b.skills !== undefined) role.skills = b.skills;
  if (b.competencies !== undefined) role.competencies = b.competencies;
  await role.save();
  res.json(role);
});

// Archived (active=false), not hard-deleted: employees hired into it keep a
// valid jobRoleId. It disappears from every list and its name can be reused.
const deleteJobRole = asyncHandler(async (req, res) => {
  assertJobRoleManager(req, res);
  const role = await JobRole.findById(req.params.id);
  if (!role) { res.status(404); throw new Error('Job role not found'); }
  role.active = false;
  await role.save();
  res.json({ message: 'Job role deleted', id: req.params.id });
});

const getHiringPlans = asyncHandler(async (req, res) => {
  guard(req, res);
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  Object.assign(filter, await deptNameFilter(req, HR_KEYS)); // dept heads: own department only
  const plans = await HiringPlan.find(filter).sort({ createdAt: -1 }).lean();
  res.json(plans);
});

// ── the CEO / Executive Director and hiring plans ────────────────────────────
// When Decision rules says hiring plans need them, HR's approval is the VET and the plan then waits for their decision. A plan is
// then never "approved" by HR alone — also not by setting status:'approved' through create / edit.

/// Do plans go to the CEO / Executive Director (and is there somebody to decide)?
const plansNeedLeadership = async () => needsLeadership(await getPolicy(), 'hiring_plan') && (await hasLeadership());

const NEEDS_LEADERSHIP = {
  code: 'NEEDS_LEADERSHIP',
  message: 'Hiring plans are approved by the CEO / Executive Director. Use "Vet and send" so they can decide.',
};

const createHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const designation = String(req.body.designation || '').trim();
  const department = String(req.body.department || '').trim();
  if (!designation || !department) {
    res.status(400);
    throw new Error('Please provide designation and department');
  }
  await assertDeptInScope(req, res, department);
  if (req.body.status === 'approved' && (await plansNeedLeadership())) return res.status(409).json(NEEDS_LEADERSHIP);
  const plan = await HiringPlan.create({
    roleId: req.body.roleId || null,
    designation,
    department,
    openings: Number(req.body.openings) || 1,
    employmentType: req.body.employmentType || 'Full-time',
    reportingLine: String(req.body.reportingLine || '').trim(),
    businessJustification: String(req.body.businessJustification || '').trim(),
    jobDescription: String(req.body.jobDescription || '').trim(),
    requiredSkills: String(req.body.requiredSkills || '').trim(),
    experienceBand: String(req.body.experienceBand || '').trim(),
    competencies: String(req.body.competencies || '').trim(),
    status: req.body.status || 'draft',
    createdBy: req.user?._id || null,
  });
  res.status(201).json(plan);
});

const updateHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  const b = req.body;
  await assertDeptInScope(req, res, plan.department);
  if (b.department !== undefined) await assertDeptInScope(req, res, b.department);
  if (b.status === 'approved' && plan.status !== 'approved' && (await plansNeedLeadership())) return res.status(409).json(NEEDS_LEADERSHIP);
  if (b.designation !== undefined) plan.designation = String(b.designation).trim();
  if (b.department !== undefined) plan.department = String(b.department).trim();
  if (b.openings !== undefined) plan.openings = Number(b.openings) || 1;
  if (b.employmentType !== undefined) plan.employmentType = b.employmentType;
  if (b.reportingLine !== undefined) plan.reportingLine = String(b.reportingLine).trim();
  if (b.businessJustification !== undefined) plan.businessJustification = String(b.businessJustification).trim();
  if (b.jobDescription !== undefined) plan.jobDescription = String(b.jobDescription).trim();
  if (b.requiredSkills !== undefined) plan.requiredSkills = String(b.requiredSkills).trim();
  if (b.experienceBand !== undefined) plan.experienceBand = String(b.experienceBand).trim();
  if (b.competencies !== undefined) plan.competencies = String(b.competencies).trim();
  if (b.status !== undefined) plan.status = b.status;
  await plan.save();
  // it was with the leaders: taken back / rejected → off their desk; edited → the vet is done again
  if (plan.leadership?.state === 'awaiting') {
    if (!['draft', 'raised'].includes(plan.status)) await withdrawFor('hiring_plan', plan._id, { user: req.user, reason: `The plan was marked ${plan.status}` });
    else await supersedeFor('hiring_plan', plan, { user: req.user });
  }
  res.json(plan);
});

const raiseHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  await assertDeptInScope(req, res, plan.department);
  plan.status = 'raised';
  plan.raisedAt = new Date();
  await plan.save();
  if (plan.leadership?.state === 'awaiting') await supersedeFor('hiring_plan', plan, { user: req.user, reason: 'The plan was raised again, so HR vets it again', force: true });
  res.json(plan);
});

const approveHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  await assertDeptInScope(req, res, plan.department);
  // Maker-checker: whoever raised the plan cannot approve it (admin excepted).
  const isAdmin = String(req.user?.role || '').toLowerCase() === 'admin';
  if (!isAdmin && plan.createdBy && req.user?._id && String(plan.createdBy) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot approve a hiring plan you raised');
  }
  // HR's approval is the vet; above that the CEO / Executive Director decide
  if (plan.status !== 'approved' && (await plansNeedLeadership())) {
    const out = await escalate({ kind: 'hiring_plan', source: plan, checker: req.user, checkNote: String(req.body?.note ?? '').trim().slice(0, 500) });
    if (out.escalated) {
      const held = await HiringPlan.findById(plan._id);
      return res.json({ ...held.toObject(), awaitingLeadership: true });
    }
  }
  plan.status = 'approved';
  plan.approvedAt = new Date();
  plan.approvedBy = req.user?._id || null;
  await plan.save();
  res.json(plan);
});

const rejectHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  await assertDeptInScope(req, res, plan.department);
  plan.status = 'rejected';
  plan.rejectionReason = String(req.body.reason || 'Rejected during review').trim();
  await plan.save();
  if (plan.leadership?.state === 'awaiting') await withdrawFor('hiring_plan', plan._id, { user: req.user, reason: 'HR rejected the plan' });
  res.json(plan);
});

const deleteHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const existingPlan = await HiringPlan.findById(req.params.id).select('department').lean();
  if (existingPlan) await assertDeptInScope(req, res, existingPlan.department);
  const plan = await HiringPlan.findByIdAndDelete(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  await withdrawFor('hiring_plan', plan._id, { user: req.user, reason: 'The plan was deleted' }).catch(() => null);
  res.json({ message: 'Hiring plan removed', id: req.params.id });
});

// ── Webhooks & Social Automation (LinkedIn & Meta) ──────────────────────────

const notifyRecruitmentTeam = async ({ title, body, link }) => {
  try {
    // Permissions live on the Role record, not the User: find the roles that
    // carry recruitment / Staff-HR access (e.g. `hr`), then their users.
    const roleRows = await Role.find({
      $or: [
        { permissions: { $in: ['recruitment', 'staff'] } },
        { permissions: { $regex: /^(recruitment|staff)\./ } },
      ],
    }).select('key').lean();
    const roleKeys = ['admin', 'manager', 'hr', ...roleRows.map((r) => String(r.key || '').toLowerCase()).filter(Boolean)];
    const recipients = await User.find({
      role: { $in: [...new Set(roleKeys)] },
      active: { $ne: false },
    }).select('_id').lean();

    if (recipients.length > 0) {
      const docs = recipients.map((u) => ({
        recipient: u._id,
        type: 'recruitment_lead',
        title,
        body,
        link: link || '/hr/recruitment',
      }));
      await Notification.insertMany(docs);
    }
  } catch (err) {
    console.warn('[Recruitment Notification] Failed to notify team:', err?.message || err);
  }
};

const incomingApplicantWebhook = asyncHandler(async (req, res) => {
  const configuredSecret = process.env.RECRUITMENT_WEBHOOK_SECRET || '';
  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (!configuredSecret) {
    res.status(503);
    throw new Error('Applicant webhook is not configured (RECRUITMENT_WEBHOOK_SECRET missing)');
  }
  // A missing secret is rejected too — previously only a WRONG one was.
  if (!providedSecret || providedSecret !== configuredSecret) {
    res.status(401);
    throw new Error('Invalid webhook secret');
  }

  const b = req.body || {};
  const name = String(b.name || b.fullName || b.candidateName || '').trim();
  if (!name) {
    res.status(400);
    throw new Error('Candidate name is required');
  }

  let jobPost = null;
  if (b.jobPostId) {
    jobPost = await JobPost.findById(b.jobPostId);
  }
  let jobTitle = String(b.jobTitle || b.role || b.position || '').trim();
  if (!jobPost && jobTitle) {
    jobPost = await JobPost.findOne({
      title: new RegExp(`^${escRx(jobTitle.trim())}$`, 'i'),
      status: 'open',
    });
  }
  if (jobPost && !jobTitle) {
    jobTitle = jobPost.title;
  }

  const rawSource = String(b.source || '').toLowerCase().trim();
  let source = 'social';
  if (rawSource.includes('linkedin')) source = 'linkedin';
  else if (rawSource.includes('meta') || rawSource.includes('fb') || rawSource.includes('facebook')) source = 'meta';
  else if (rawSource.includes('insta')) source = 'instagram';
  else if (rawSource.includes('referral')) source = 'referral';
  else if (rawSource.includes('portal') || rawSource.includes('indeed') || rawSource.includes('naukri')) source = 'job_portal';
  else if (rawSource.includes('web')) source = 'website';

  const candidate = await Candidate.create({
    name,
    email: String(b.email || '').trim().toLowerCase(),
    phone: String(b.phone || b.phoneNumber || b.mobile || '').trim(),
    jobPostId: jobPost?._id || null,
    jobTitle: jobTitle || 'Applicant',
    source,
    referrer: String(b.referrer || (source === 'linkedin' ? 'LinkedIn Easy Apply' : source === 'meta' ? 'Meta Lead Ad' : 'Social Automation')).trim(),
    stage: 'applied',
    resumeUrl: String(b.resumeUrl || b.resume || b.cvUrl || '').trim(),
    notes: String(b.notes || b.coverLetter || b.message || (b.portfolio ? `Portfolio: ${b.portfolio}` : '')).trim(),
  });

  await notifyRecruitmentTeam({
    title: `New Applicant: ${name}`,
    body: `Applied for ${jobTitle || 'Job Opening'} via ${source.toUpperCase()}`,
    link: '/hr/recruitment',
  });

  res.status(201).json({
    success: true,
    message: 'Candidate application received and queued in recruitment pipeline',
    candidate: {
      id: candidate._id,
      name: candidate.name,
      jobTitle: candidate.jobTitle,
      source: candidate.source,
      stage: candidate.stage,
    },
  });
});

const metaWebhookVerify = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || '';

  if (verifyToken && mode === 'subscribe' && token === verifyToken) {
    console.log('[Meta Webhook] Verification challenge passed successfully');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

const metaWebhookReceive = asyncHandler(async (req, res) => {
  res.status(200).json({ received: true });
  console.log('[Meta Webhook] Leadgen event received:', JSON.stringify(req.body));
});

const getJobPostSocialCopy = asyncHandler(async (req, res) => {
  const post = await JobPost.findById(req.params.id).populate('designationId', 'name').lean();
  if (!post) {
    res.status(404);
    throw new Error('Job post not found');
  }

  const studio = 'Hilite Business Park, Kozhikode, Kerala';
  const applyUrl = `https://nizanmakeovers.com/careers/${post._id}`;

  const linkedinCopy = `🌟 WE ARE HIRING: ${post.title.toUpperCase()} 🌟

Nizan Beauty Ventures Pvt. Ltd. ("Nizan Makeovers") is expanding its studio creative team at ${studio}.

📍 Department: ${post.department || 'Creative & Operations'}
💼 Employment Type: ${post.type || 'Full-time'}
🏢 Location: ${post.location || 'Kozhikode, Kerala'}
👥 Open Positions: ${post.openings || 1}

Role Overview:
${post.description || 'Join Kerala’s premier luxury bridal and creative event production team. Be part of an innovative studio environment with cutting-edge artistry, competitive compensation, and structured career growth.'}

What We Offer:
• Premium studio workspace at Hilite Business Park
• Attractive compensation package with performance incentives
• Comprehensive training & skill enhancement programs
• Inclusive, high-performance team culture

📩 Apply Now:
Direct Link: ${applyUrl}
Or send your CV & portfolio to careers@nizanmakeovers.com

#Hiring #${post.title.replace(/[^a-zA-Z0-9]/g, '')} #NizanMakeovers #LuxuryBridal #KeralaJobs #KozhikodeCareers #JoinOurTeam`;

  const metaCopy = `✨ WE'RE HIRING: ${post.title.toUpperCase()} ✨

Are you passionate about luxury beauty, artistry, and exceptional client experiences? Join the Nizan family at Hilite Business Park, Kozhikode!

📌 Position: ${post.title}
📍 Location: ${post.location || 'Kozhikode, Kerala'}
💼 Type: ${post.type || 'Full-time'}
👥 Openings: ${post.openings || 1}

👉 How to Apply:
1. Tap the link in our bio: ${applyUrl}
2. Or DM us your CV & portfolio @nizanmakeovers
3. Email us: careers@nizanmakeovers.com

Tag someone who would be perfect for this role! 👇

#NizanMakeovers #NowHiring #KozhikodeJobs #MakeupArtistJobs #CareerOpportunity #TeamNizan`;

  const encodedUrl = encodeURIComponent(applyUrl);
  const encodedText = encodeURIComponent(`We are hiring: ${post.title} at Nizan Makeovers! Apply here: ${applyUrl}`);

  res.json({
    jobPostId: post._id,
    title: post.title,
    applyUrl,
    linkedin: {
      title: 'LinkedIn Post Copy',
      copy: linkedinCopy,
      shareUrl: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
    },
    meta: {
      title: 'Instagram & Facebook Post Copy',
      copy: metaCopy,
      facebookShareUrl: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
      whatsappShareUrl: `https://api.whatsapp.com/send?text=${encodedText}`,
    },
  });
});

const getRecruitmentWebhookConfig = asyncHandler(async (req, res) => {
  guard(req, res);
  await assertHrWide(req, res); // response reveals the webhook secret
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const secret = process.env.RECRUITMENT_WEBHOOK_SECRET || '';

  res.json({
    webhookUrl: `${baseUrl}/api/recruitment/webhooks/incoming-applicant`,
    metaWebhookUrl: `${baseUrl}/api/recruitment/webhooks/meta`,
    metaVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
    secretHeader: 'x-webhook-secret',
    secret,
    samplePayload: {
      name: 'Ananya Sharma',
      email: 'ananya@example.com',
      phone: '+91 9876543210',
      jobTitle: 'Senior Makeup Specialist',
      jobPostId: 'optional_mongo_job_post_id',
      source: 'linkedin',
      referrer: 'LinkedIn Easy Apply',
      resumeUrl: 'https://example.com/resume.pdf',
      notes: '5 years of luxury bridal experience',
    },
    integrations: [
      {
        platform: 'LinkedIn (Easy Apply & Lead Gen)',
        recommendedSetup: 'Zapier or Make.com Webhook',
        instruction: 'Trigger on "New LinkedIn Lead Gen Form Response", send POST to webhookUrl with header x-webhook-secret.',
      },
      {
        platform: 'Meta (Facebook & Instagram Lead Ads)',
        recommendedSetup: 'Direct Webhook or Zapier/Make',
        instruction: 'Configure Meta App Webhook with metaWebhookUrl & metaVerifyToken, or forward Meta Instant Forms via Zapier.',
      },
    ],
  });
});

export {
  getJobPosts,
  createJobPost,
  updateJobPost,
  deleteJobPost,
  getCandidates,
  createCandidate,
  bulkImportCandidates,
  updateCandidate,
  deleteCandidate,
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
  acceptOffer,
  declineOffer,
  getJobRoles,
  createJobRole,
  updateJobRole,
  deleteJobRole,
  getHiringPlans,
  createHiringPlan,
  updateHiringPlan,
  raiseHiringPlan,
  approveHiringPlan,
  rejectHiringPlan,
  deleteHiringPlan,
  incomingApplicantWebhook,
  metaWebhookVerify,
  metaWebhookReceive,
  getJobPostSocialCopy,
  getRecruitmentWebhookConfig,
};
