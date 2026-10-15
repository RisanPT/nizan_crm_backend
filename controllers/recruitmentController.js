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
  const post = await JobPost.create({
    title,
    department: String(req.body.department || '').trim(),
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
  const filter = {};
  if (req.query.jobPostId) filter.jobPostId = req.query.jobPostId;
  if (req.query.stage && req.query.stage !== 'all') filter.stage = req.query.stage;
  const rows = await Candidate.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  res.json(rows);
});

const createCandidate = asyncHandler(async (req, res) => {
  guard(req, res);
  const name = String(req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide the candidate name'); }
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
  let role = offer?.designation || candidate.jobTitle || 'Staff';
  let department = offer?.department || '';
  if (!department && candidate.jobPostId) {
    const post = await JobPost.findById(candidate.jobPostId).select('department title').lean();
    if (post?.department) department = post.department;
    if (!role && post?.title) role = post.title;
  }
  if (!department && role) {
    const jr = await JobRole.findOne({ designation: { $regex: new RegExp(`^${role.trim()}$`, 'i') } }).select('dept').lean();
    if (jr?.dept) department = jr.dept;
  }
  if (!department) department = 'General';

  // Find or create employee
  let employee = null;
  if (offer?.employeeId) {
    employee = await Employee.findById(offer.employeeId);
  }
  if (!employee && candidate.email) {
    employee = await Employee.findOne({ email: candidate.email.toLowerCase().trim() });
  }
  if (!employee) {
    employee = await Employee.findOne({ name: candidate.name.trim() });
  }

  if (!employee) {
    employee = await Employee.create({
      name: candidate.name || 'New hire',
      email: (candidate.email || '').toLowerCase().trim(),
      phone: candidate.phone || '',
      type: 'full-time',
      artistRole: 'staff',
      specialization: role,
      status: 'active',
      role,
      department,
      category: 'administrative',
      salaryType: 'fixed_monthly',
      baseSalary: offer?.salary || 0,
    });
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

  const tasks = DEFAULT_ONBOARDING_TASKS.map((t, idx) => ({
    title: t,
    done: idx < 2, // First 1-2 steps typically complete or ready
    owner: 'HR Team',
    note: '',
  }));

  const documents = [
    { name: 'Signed offer letter', owner: employee.name, required: true, status: 'Received' },
    { name: 'Aadhaar & PAN', owner: employee.name, required: true, status: 'Received' },
    { name: 'Bank account proof', owner: employee.name, required: true, status: 'Pending' },
    { name: 'Previous experience letter', owner: employee.name, required: false, status: 'Not required' },
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
  const cand = await Candidate.findByIdAndDelete(req.params.id);
  if (!cand) { res.status(404); throw new Error('Candidate not found'); }
  await Offer.deleteMany({ candidateId: cand._id, status: { $in: ['draft', 'sent'] } });
  res.json({ message: 'Candidate removed', id: req.params.id });
});

// ── Offers ───────────────────────────────────────────────────────────────────
const getOffers = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.candidateId) filter.candidateId = req.query.candidateId;
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  const rows = await Offer.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  res.json(rows);
});

const createOffer = asyncHandler(async (req, res) => {
  guard(req, res);
  const candidateId = String(req.body.candidateId || '').trim();
  if (!candidateId) { res.status(400); throw new Error('A candidate is required'); }
  const cand = await Candidate.findById(candidateId);
  if (!cand) { res.status(404); throw new Error('Candidate not found'); }

  let department = String(req.body.department || '').trim();
  if (!department && cand.jobPostId) {
    const post = await JobPost.findById(cand.jobPostId).select('department').lean();
    if (post?.department) department = post.department;
  }
  if (!department && (req.body.designation || cand.jobTitle)) {
    const roleTitle = String(req.body.designation || cand.jobTitle).trim();
    const role = await JobRole.findOne({ designation: { $regex: new RegExp(`^${roleTitle}$`, 'i') } }).select('dept').lean();
    if (role?.dept) department = role.dept;
  }

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

  const cand = await Candidate.findById(offer.candidateId);
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
const DEFAULT_ROLES_SEED = [
  {
    roleCode: 'board-teams',
    designation: 'Board of Directors / Apex',
    shortTitle: 'Board',
    dept: 'Executive / Governance',
    band: 'L6',
    tier: 1,
    parentId: null,
    reportsTo: 'Apex / Shareholders',
    team: 'Governance',
    headcount: 3,
    purpose: 'Provide governance, approve major capital allocations, and steer long-term vision.',
    responsibilities: ['Strategic oversight', 'Governance & compliance', 'Executive performance'],
    deliverables: 'Company longevity, financial resilience, strategic alignment.',
    exp: '20+ yrs',
    qual: 'Executive Leadership',
    skills: [{ name: 'Corporate Governance', score: 5.0 }, { name: 'Capital Allocation', score: 5.0 }],
    competencies: ['Stewardship', 'Vision', 'Integrity'],
  },
  {
    roleCode: 'ceo',
    designation: 'Chief Executive Officer (CEO)',
    shortTitle: 'CEO',
    dept: 'Executive / Governance',
    band: 'L6',
    tier: 2,
    parentId: 'board-teams',
    reportsTo: 'Board of Directors',
    team: 'Executive Office',
    headcount: 1,
    purpose: 'Set company vision and strategy, lead the C-suite, and own overall business performance.',
    responsibilities: ['Own company P&L', 'Lead CFO, CTO, and COO', 'Represent company to partners'],
    deliverables: 'Revenue and margin targets met, aligned leadership, board confidence.',
    exp: '15+ yrs',
    qual: 'MBA / Proven executive leadership track record',
    skills: [{ name: 'Business Strategy', score: 5.0 }, { name: 'Leadership & Alignment', score: 4.9 }, { name: 'P&L Ownership', score: 4.8 }],
    competencies: ['Visionary Leadership', 'Decisiveness', 'Commercial Acumen'],
  },
  {
    roleCode: 'cfo',
    designation: 'Chief Financial Officer (CFO)',
    shortTitle: 'CFO',
    dept: 'Finance & Accounts',
    band: 'L5',
    tier: 3,
    parentId: 'ceo',
    reportsTo: 'CEO',
    team: 'C-Suite',
    headcount: 1,
    purpose: 'Own company finance strategy, statutory compliance, treasury, and financial governance.',
    responsibilities: ['Direct budgeting & forecasting', 'Statutory, tax, and audit compliance', 'Treasury & capital allocation'],
    deliverables: 'Clean audits, healthy cash flow, on-time statutory closings.',
    exp: '12-15 yrs',
    qual: 'Chartered Accountant (CA) / CPA / MBA Finance',
    skills: [{ name: 'Financial Strategy', score: 5.0 }, { name: 'Statutory & Tax Governance', score: 4.8 }, { name: 'Treasury & Capital', score: 4.7 }],
    competencies: ['Financial Rigor', 'Strategic Thinking', 'Integrity'],
  },
  {
    roleCode: 'cto',
    designation: 'Chief Technology Officer (CTO)',
    shortTitle: 'CTO',
    dept: 'Technology & Systems (IT)',
    band: 'L5',
    tier: 3,
    parentId: 'ceo',
    reportsTo: 'CEO',
    team: 'C-Suite (CXO)',
    headcount: 1,
    purpose: 'Own company technology: the HRMS/CRM platform, cloud architecture, security, and IT function.',
    responsibilities: ['Define technical architecture', 'Manage cloud infrastructure & security', 'Lead IT and engineering'],
    deliverables: '99.9% uptime, secure SOC-2 compliant architecture, agile delivery cycles.',
    exp: '10-14 yrs',
    qual: 'B.Tech / M.Tech in Computer Science',
    skills: [{ name: 'System Architecture & Cloud', score: 5.0 }, { name: 'Full-Stack & Distributed DBs', score: 4.8 }, { name: 'InfoSec & Governance', score: 4.7 }],
    competencies: ['Technical Vision', 'Architectural Rigor', 'Agile Execution'],
  },
  {
    roleCode: 'coo',
    designation: 'Chief Operating Officer (COO)',
    shortTitle: 'COO',
    dept: 'Studio & Services Ops',
    band: 'L5',
    tier: 3,
    parentId: 'ceo',
    reportsTo: 'CEO',
    team: 'C-Suite',
    headcount: 1,
    purpose: 'Own end-to-end operations across studios, academy, and services; operating heads report into this office.',
    responsibilities: ['Steer operating performance across studios', 'Align capacity, quality, and budgets', 'Translate strategy into departmental targets'],
    deliverables: 'NPS > 75, on-budget operations, aligned department scorecards.',
    exp: '12-15 yrs',
    qual: "Master's in Business / Operations Management",
    skills: [{ name: 'Multi-Unit Operations', score: 4.9 }, { name: 'Capacity & Budget Planning', score: 4.7 }, { name: 'People Leadership', score: 4.8 }],
    competencies: ['Operational Leadership', 'Execution', 'Quality Governance'],
  },
  {
    roleCode: 'finance-head',
    designation: 'Finance Head',
    shortTitle: 'Finance Head',
    dept: 'Finance & Accounts',
    band: 'L4',
    tier: 4,
    parentId: 'cfo',
    reportsTo: 'CFO',
    team: 'Finance Leadership',
    headcount: 1,
    purpose: 'Lead financial governance, statutory tax compliance, corporate treasury, and internal audits.',
    responsibilities: ['Formulate annual operating budgets', 'Ensure 100% compliance with GST & direct taxes', 'Oversee AP, AR, and payroll audit pipelines'],
    deliverables: 'Timely statutory closings, clean audit reports, optimized working capital.',
    exp: '10-12 yrs',
    qual: 'Chartered Accountant (CA) / CMA / MBA Finance',
    skills: [{ name: 'Corporate Financial Modeling', score: 5.0 }, { name: 'Statutory GST & Corporate Tax', score: 4.8 }, { name: 'Internal Audit', score: 4.7 }],
    competencies: ['Statutory Integrity', 'Analytical Precision', 'Treasury Control'],
  },
  {
    roleCode: 'eng-lead',
    designation: 'IT Head',
    shortTitle: 'IT Head',
    dept: 'Technology & Systems (IT)',
    band: 'L4',
    tier: 4,
    parentId: 'cto',
    reportsTo: 'CTO',
    team: 'IT Leadership',
    headcount: 1,
    purpose: 'Lead the IT and engineering team building and running the HRMS/CRM platform and release pipelines.',
    responsibilities: ['Own sprint delivery & code quality', 'Run CI/CD and production monitoring', 'Mentor engineers'],
    deliverables: 'On-time releases, < 0.1% error rate, secure and documented services.',
    exp: '6-9 yrs',
    qual: 'B.Tech / M.Tech in Computer Science',
    skills: [{ name: 'Full-Stack Engineering', score: 4.8 }, { name: 'API & Integration Design', score: 4.7 }, { name: 'CI/CD & DevOps', score: 4.6 }],
    competencies: ['Technical Ownership', 'Delivery Focus', 'Mentorship'],
  },
  {
    roleCode: 'studio-head',
    designation: 'Studio Operations Head',
    shortTitle: 'Studio Head',
    dept: 'Studio & Services Ops',
    band: 'L4',
    tier: 4,
    parentId: 'coo',
    reportsTo: 'COO',
    team: 'Studio Leadership',
    headcount: 1,
    purpose: 'Own day-to-day studio operations: bookings, artist scheduling, hygiene standards, and client experience.',
    responsibilities: ['Run multi-studio scheduling & staffing', 'Enforce hygiene, safety, and grooming standards', 'Resolve client escalations'],
    deliverables: 'NPS > 75, on-time turnaround, zero hygiene escalations.',
    exp: '6-9 yrs',
    qual: "Bachelor's in Hospitality / Operations",
    skills: [{ name: 'Studio Scheduling & Capacity', score: 4.7 }, { name: 'Hygiene & Safety Governance', score: 4.8 }, { name: 'Client Experience', score: 4.6 }],
    competencies: ['Operational Discipline', 'People Leadership', 'Service Excellence'],
  },
  {
    roleCode: 'academy-head',
    designation: 'Academy Head (Principal)',
    shortTitle: 'Academy Head',
    dept: 'Academy',
    band: 'L4',
    tier: 4,
    parentId: 'coo',
    reportsTo: 'COO',
    team: 'Academy Leadership',
    headcount: 1,
    purpose: 'Lead the makeup academy: curriculum quality, trainer performance, admissions, and student outcomes.',
    responsibilities: ['Own curriculum roadmap & certifications', 'Supervise trainers and monitor student pass rates', 'Drive admissions targets'],
    deliverables: 'Certification pass rate > 92%, trainer score > 4.7, full batch enrolment.',
    exp: '7-10 yrs',
    qual: 'Master Trainer / Cosmetology Educator Certification',
    skills: [{ name: 'Curriculum & Pedagogy', score: 4.8 }, { name: 'Trainer Management', score: 4.6 }, { name: 'Admissions & Growth', score: 4.4 }],
    competencies: ['Educational Leadership', 'Mentorship', 'Quality Governance'],
  },
  {
    roleCode: 'sr-bridal-stylist',
    designation: 'Senior Bridal Stylist',
    shortTitle: 'Senior Bridal Stylist',
    dept: 'Bridal Styling',
    band: 'L4',
    tier: 5,
    parentId: 'studio-head',
    reportsTo: 'Studio Operations Head',
    team: 'Bridal Styling Team',
    headcount: 4,
    purpose: 'Lead luxury HD bridal makeovers end-to-end and own client satisfaction on high-stakes wedding days.',
    responsibilities: ['Consult, design, and execute bespoke HD bridal makeup', 'Mentor trainee artists on hygiene', 'Own client timelines across wedding schedules'],
    deliverables: 'On-brand looks, 4.8+ client rating, zero hygiene escalations.',
    exp: '4-6 yrs',
    qual: 'Diploma in Cosmetology / Bridal Makeup Certification',
    skills: [{ name: 'HD Bridal & Airbrush Contouring', score: 5.0 }, { name: 'Traditional & Muhurtham Draping', score: 4.8 }, { name: 'Skin Triage & Color Correction', score: 4.7 }],
    competencies: ['Creative Precision', 'Composure Under Pressure', 'Hygiene Discipline'],
  },
  {
    roleCode: 'academy-trainer',
    designation: 'Academy Trainer',
    shortTitle: 'Academy Trainer',
    dept: 'Academy',
    band: 'L4',
    tier: 5,
    parentId: 'academy-head',
    reportsTo: 'Academy Head',
    team: 'Academy Team',
    headcount: 2,
    purpose: 'Deliver professional makeup and hairstyling curriculum to academy students and assess practical certifications.',
    responsibilities: ['Lead live stage demos & workshops', 'Update syllabus to reflect current trends', 'Track student graduation metrics'],
    deliverables: 'Student certification pass rate > 92%, trainer feedback score > 4.7.',
    exp: '3-5 yrs',
    qual: 'Train-the-Trainer Certification / Master Makeup Diploma',
    skills: [{ name: 'Curriculum Delivery & Stage Demos', score: 4.9 }, { name: 'Cosmetic Chemistry & Hygiene', score: 4.6 }, { name: 'Student Mentorship', score: 4.8 }],
    competencies: ['Stage Presence', 'Patience', 'Pedagogical Clarity'],
  },
  {
    roleCode: 'studio-asst',
    designation: 'Studio Assistant',
    shortTitle: 'Studio Assistant',
    dept: 'Studio Ops',
    band: 'L2',
    tier: 5,
    parentId: 'studio-head',
    reportsTo: 'Studio Operations Head',
    team: 'Studio Operations Team',
    headcount: 4,
    purpose: 'Maintain studio hygiene, sanitize equipment, prepare vanity workstations, and track product inventory.',
    responsibilities: ['Sanitize brushes, palettes, and styling tools', 'Prep workstation setups ahead of appointments', 'Conduct daily stock counts'],
    deliverables: 'Zero hygiene non-compliances, stations prepped 15 min prior to appointments.',
    exp: '0-2 yrs',
    qual: 'Higher Secondary / Any Diploma / Salon Basics Training',
    skills: [{ name: 'Sanitization & Brush Care', score: 4.8 }, { name: 'Vanity Station Preparation', score: 4.7 }, { name: 'Inventory Stock Logging', score: 4.4 }],
    competencies: ['Reliability', 'Workplace Discipline', 'Swift Attention'],
  },
  {
    roleCode: 'sr-accountant',
    designation: 'Senior Accountant',
    shortTitle: 'Senior Accountant',
    dept: 'Finance & Accounts',
    band: 'L3',
    tier: 5,
    parentId: 'finance-head',
    reportsTo: 'Finance Head',
    team: 'Finance Team',
    headcount: 2,
    purpose: 'Manage comprehensive general ledger books, monthly accounts closing, tax filings, and bank reconciliations.',
    responsibilities: ['Reconcile salon billing & vendor invoices', 'Prepare monthly P&L and tax computations', 'Coordinate with statutory auditors'],
    deliverables: 'Accounts finalized by 5th of each month, zero filing delays.',
    exp: '4-6 yrs',
    qual: 'M.Com / CA Inter / B.Com',
    skills: [{ name: 'General Ledger Accounting', score: 4.8 }, { name: 'GST Returns (GSTR-1, 3B)', score: 4.7 }, { name: 'Tally Prime / ERP', score: 4.9 }],
    competencies: ['Attention to Detail', 'Reconciliation Speed', 'Statutory Discipline'],
  },
  {
    roleCode: 'software-eng',
    designation: 'Software Engineer',
    shortTitle: 'Software Engineer',
    dept: 'Technology & Systems (IT)',
    band: 'L3',
    tier: 5,
    parentId: 'eng-lead',
    reportsTo: 'IT Head',
    team: 'IT Team',
    headcount: 3,
    purpose: 'Build and maintain features across the HRMS/CRM web and mobile apps and backend services.',
    responsibilities: ['Implement features and automated tests', 'Integrate third-party APIs', 'Participate in code reviews'],
    deliverables: 'Shipped features per sprint, green test suite, timely bug fixes.',
    exp: '2-5 yrs',
    qual: 'B.Tech / BCA / MCA or equivalent',
    skills: [{ name: 'JavaScript / Flutter / Node', score: 4.6 }, { name: 'Databases & Queries', score: 4.5 }, { name: 'Testing & Debugging', score: 4.5 }],
    competencies: ['Craftsmanship', 'Collaboration', 'Problem Solving'],
  },
];

const getJobRoles = asyncHandler(async (req, res) => {
  let roles = await JobRole.find({ active: true }).sort({ tier: 1, designation: 1 }).lean();
  if (roles.length === 0) {
    await JobRole.insertMany(DEFAULT_ROLES_SEED);
    roles = await JobRole.find({ active: true }).sort({ tier: 1, designation: 1 }).lean();
  }
  res.json(roles);
});

const createJobRole = asyncHandler(async (req, res) => {
  guard(req, res);
  const designation = String(req.body.designation || '').trim();
  if (!designation) { res.status(400); throw new Error('Please provide a designation title'); }
  const role = await JobRole.create({
    roleCode: req.body.roleCode || `role-${Date.now()}`,
    designation,
    shortTitle: req.body.shortTitle || designation,
    dept: String(req.body.dept || 'Operations').trim(),
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
  guard(req, res);
  const role = await JobRole.findById(req.params.id);
  if (!role) { res.status(404); throw new Error('Job role not found'); }
  const b = req.body;
  if (b.designation !== undefined) role.designation = String(b.designation).trim();
  if (b.shortTitle !== undefined) role.shortTitle = String(b.shortTitle).trim();
  if (b.dept !== undefined) role.dept = String(b.dept).trim();
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

const deleteJobRole = asyncHandler(async (req, res) => {
  guard(req, res);
  const role = await JobRole.findById(req.params.id);
  if (!role) { res.status(404); throw new Error('Job role not found'); }
  role.active = false;
  await role.save();
  res.json({ message: 'Job role archived', id: req.params.id });
});

const getHiringPlans = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  const plans = await HiringPlan.find(filter).sort({ createdAt: -1 }).lean();
  res.json(plans);
});

const createHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const designation = String(req.body.designation || '').trim();
  const department = String(req.body.department || '').trim();
  if (!designation || !department) {
    res.status(400);
    throw new Error('Please provide designation and department');
  }
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
  res.json(plan);
});

const raiseHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  plan.status = 'raised';
  plan.raisedAt = new Date();
  await plan.save();
  res.json(plan);
});

const approveHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findById(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
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
  plan.status = 'rejected';
  plan.rejectionReason = String(req.body.reason || 'Rejected during review').trim();
  await plan.save();
  res.json(plan);
});

const deleteHiringPlan = asyncHandler(async (req, res) => {
  guard(req, res);
  const plan = await HiringPlan.findByIdAndDelete(req.params.id);
  if (!plan) { res.status(404); throw new Error('Hiring plan not found'); }
  res.json({ message: 'Hiring plan removed', id: req.params.id });
});

// ── Webhooks & Social Automation (LinkedIn & Meta) ──────────────────────────

const notifyRecruitmentTeam = async ({ title, body, link }) => {
  try {
    const recipients = await User.find({
      $or: [
        { role: { $in: ['admin', 'manager'] } },
        { permissions: { $in: ['recruitment', 'staff'] } },
      ],
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
  const configuredSecret = process.env.RECRUITMENT_WEBHOOK_SECRET || 'nizan_recruitment_webhook_secret_2026';
  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (configuredSecret && providedSecret && providedSecret !== configuredSecret) {
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
      title: new RegExp(`^${jobTitle.trim()}$`, 'i'),
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
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || 'nizan_meta_verify_2026';

  if (mode === 'subscribe' && token === verifyToken) {
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
  const host = req.get('host');
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;
  const secret = process.env.RECRUITMENT_WEBHOOK_SECRET || 'nizan_recruitment_webhook_secret_2026';

  res.json({
    webhookUrl: `${baseUrl}/api/recruitment/webhooks/incoming-applicant`,
    metaWebhookUrl: `${baseUrl}/api/recruitment/webhooks/meta`,
    metaVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'nizan_meta_verify_2026',
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
