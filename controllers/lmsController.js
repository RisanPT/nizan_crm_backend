import asyncHandler from 'express-async-handler';
import Course from '../models/Course.js';
import Enrollment from '../models/Enrollment.js';
import Employee from '../models/Employee.js';

const empPopulate = { path: 'employeeId', select: 'name department' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
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
  const rows = await Enrollment.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(500);
  res.json(rows);
});

// @route POST /api/lms/enroll  { courseId, employeeId? }  (self or HR-assigned)
const enroll = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to enrol others'); }
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
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }

  if (req.body.progress !== undefined) {
    row.progress = Math.max(0, Math.min(100, Number(req.body.progress) || 0));
  }
  if (req.body.status !== undefined) row.status = req.body.status;
  // Derive status from progress unless explicitly set.
  if (req.body.status === undefined) {
    if (row.progress >= 100) row.status = 'completed';
    else if (row.progress > 0) row.status = 'in_progress';
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
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  await row.deleteOne();
  res.json({ message: 'Enrolment removed', id: req.params.id });
});

// ── Orientation Plans & 1-Week Job Role Syllabus (FR-3.2, FR-3.4) ────────────
import OrientationPlan from '../models/OrientationPlan.js';
import OrientationAssignment from '../models/OrientationAssignment.js';
import JobRole from '../models/JobRole.js';

const SEED_ORIENTATION_PLANS = [
  // ── 1. Technology & Systems (IT) ───────────────────────────────────────────
  {
    roleTitle: 'Senior Dev-ops engineer',
    department: 'Technology & Systems (IT)',
    trainerName: 'Infrastructure Lead',
    overview:
      '7-day production readiness orientation covering repository topologies, Kubernetes clusters, secret management, CI/CD pipelines, and disaster recovery protocol.',
    documentContent: `# Senior Dev-ops Engineer — 1-Week Orientation Plan

## Overview
Welcome to Team N Systems. This one-week intensive syllabus prepares you to autonomously handle our multi-cloud deployment pipelines, infrastructure as code, monitoring stacks, and production incident response.

### Mentor & Sign-Off Lead: Infrastructure Lead / Engineering Manager
### Target Duration: 7 Business Days

---
### Day 1: Culture, Credentials & System Setup
- Company engineering culture, SLA expectations & compliance briefing
- Workstation, VPN, GPG keys, and IAM single-sign-on provisioning
- Production incident communication hierarchy and PagerDuty onboarding

### Day 2: Architecture, Repositories & Tooling
- Review microservices architecture and Kubernetes manifest structures
- Setup Terraform, Helm, Docker, and local development clusters
- Secrets management walkthrough (HashiCorp Vault / Cloud KMS)

### Day 3: Team Workflows & Shadowing
- Shadow Senior DevOps engineer during staging deployment run
- Walkthrough of Prometheus, Grafana, and Datadog alert triage
- Log tracing and audit logging compliance walkthrough

### Day 4: Core Execution & Paired Deployment
- Assigned first low-risk infrastructure task: optimize build caching
- Paired deployment with mentor on staging environment
- Merge request code review and security automated testing

### Day 5: Independent Practice & Disaster Recovery
- Perform controlled rollback and disaster recovery dry run
- Audit resource utilization and Kubernetes node autoscaling rules
- End-of-day debrief and retrospective notes with Mentor

### Day 6: Billing, FinOps & Security Compliance
- Cloud cost monitoring and monthly budget alerting review
- Vulnerability scanning reports and zero-trust perimeter policies
- Cross-functional handoff with frontend and backend engineering leads

### Day 7: Final Mock Run & Sign-Off
- Full mock emergency response drill (simulated staging outage)
- 1-on-1 performance review & expectation calibration with Engineering Manager
- Milestone completion sign-off and production commit rights granted
`,
    status: 'Active',
    days: [
      {
        dayNumber: 1,
        title: 'Culture, Credentials & System Setup',
        topics: [
          'Company engineering culture, SLA expectations & compliance briefing',
          'Workstation, VPN, GPG keys, and IAM single-sign-on provisioning',
          'Production incident communication hierarchy and PagerDuty onboarding',
        ],
        mandatorySignOff: true,
      },
      {
        dayNumber: 2,
        title: 'Architecture, Repositories & Tooling',
        topics: [
          'Review microservices architecture and Kubernetes manifest structures',
          'Setup Terraform, Helm, Docker, and local development clusters',
          'Secrets management walkthrough (HashiCorp Vault / Cloud KMS)',
        ],
        mandatorySignOff: true,
      },
      {
        dayNumber: 3,
        title: 'Team Workflows & Shadowing',
        topics: [
          'Shadow Senior DevOps engineer during staging deployment run',
          'Walkthrough of Prometheus, Grafana, and Datadog alert triage',
          'Log tracing and audit logging compliance walkthrough',
        ],
        mandatorySignOff: true,
      },
      {
        dayNumber: 4,
        title: 'Core Execution & Paired Deployment',
        topics: [
          'Assigned first low-risk infrastructure task: optimize build caching',
          'Paired deployment with mentor on staging environment',
          'Merge request code review and security automated testing',
        ],
        mandatorySignOff: true,
      },
      {
        dayNumber: 5,
        title: 'Independent Practice & DR Dry-run',
        topics: [
          'Perform controlled rollback and disaster recovery dry run',
          'Audit resource utilization and Kubernetes node autoscaling rules',
          'End-of-day debrief and retrospective notes with Mentor',
        ],
        mandatorySignOff: true,
      },
      {
        dayNumber: 6,
        title: 'Billing, FinOps & Security Compliance',
        topics: [
          'Cloud cost monitoring and monthly budget alerting review',
          'Vulnerability scanning reports and zero-trust perimeter policies',
          'Cross-functional handoff with frontend and backend leads',
        ],
        mandatorySignOff: false,
      },
      {
        dayNumber: 7,
        title: 'Final Mock Run & Milestone Sign-Off',
        topics: [
          'Full mock emergency response drill (simulated staging outage)',
          '1-on-1 performance review & expectation calibration with Manager',
          'Milestone completion sign-off and production commit rights granted',
        ],
        mandatorySignOff: true,
      },
    ],
  },
  {
    roleTitle: 'Software Engineer',
    department: 'Technology & Systems (IT)',
    trainerName: 'IT Head',
    overview:
      '7-day onboarding for Full-Stack developers: codebase deep-dive, Flutter mobile & web clients, Node/Express backend APIs, database indexing, and staging release cycles.',
    documentContent: `# Software Engineer — 1-Week Orientation Plan

## Overview
Welcome to the Core Engineering team. This 7-day program takes you from local environment setup to shipping your first peer-reviewed feature to staging.

### Lead Mentor: IT Head / Senior Tech Lead
### Duration: 7 Days

---
### Day 1: Dev Environment & Architecture Walkthrough
- Git repositories checkout, local Docker MongoDB, and Node.js setup
- Flutter SDK setup, web/mobile run verification, and hot reload tooling
- Codebase tour: architecture boundaries, state management, and conventions

### Day 2: Frontend Engineering & Design System
- Walkthrough of Flutter CRM screens, widgets, and Riverpod providers
- Design token integration matching HRMS_Design.html standards
- Practice task: small UI refinement and theme testing

### Day 3: Backend APIs & Data Models
- Express async handlers, route guards, and JWT access control
- Mongoose schema validations, indexing, and aggregations
- Postman / ThunderClient test collection walkthrough

### Day 4: Paired Feature Sprint
- Assigned sprint ticket with Senior Engineer pairing
- Writing unit tests and widget tests for new feature
- Branching strategy, commit formatting, and Git PR conventions

### Day 5: Code Review & Staging Deployment
- PR review session with Tech Lead and addressing feedback
- Automated CI pipeline execution and integration test checks
- Verification on Staging environment across desktop and tablet views

### Day 6: Performance, Sentry & Monitoring
- Memory profiling, bundle sizing, and query performance audits
- Error tracking with Sentry and API latency inspection
- Logging best practices and cross-team API documentation

### Day 7: Final Code Review & Sign-Off
- Independent bug triage exercise
- 1-on-1 sprint calibration with IT Head
- Certification sign-off and formal sprint assignment
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Dev Environment & Architecture', topics: ['Git checkout & Docker MongoDB', 'Flutter SDK & web setup', 'Codebase architecture tour'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Frontend & Design System', topics: ['CRM widgets & Riverpod providers', 'Design token integration', 'UI refinement practice'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Backend APIs & Data Models', topics: ['Express handlers & JWT guards', 'Mongoose schemas & indexing', 'API test collection walkthrough'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Paired Feature Sprint', topics: ['Sprint ticket pairing', 'Unit & widget test writing', 'PR creation conventions'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Code Review & Staging Deploy', topics: ['PR review & revisions', 'CI pipeline validation', 'Staging multi-device QA'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Performance & Error Tracking', topics: ['Query performance profiling', 'Sentry error triage', 'API documentation'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Sprint Readiness & Sign-Off', topics: ['Independent bug triage test', '1-on-1 sprint calibration', 'Lead sign-off'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'IT Support Engineer',
    department: 'Technology & Systems (IT)',
    trainerName: 'Systems Admin Lead',
    overview:
      '7-day plan on network infrastructure, hardware inventory, MDM device management, and employee helpdesk SLA resolution.',
    documentContent: `# IT Support Engineer — 1-Week Orientation Plan

## Overview
Equips you to autonomously manage employee hardware, office network infrastructure, SaaS access, and IT ticketing SLAs.

### Lead Mentor: Systems Admin Lead
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Company Intro & IT Policies', topics: ['Acceptable use policy', 'Inventory software setup', 'Key card & security badge access'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Hardware Provisioning', topics: ['Mac/Windows provisioning profiles', 'Peripheral testing', 'Asset tagging standards'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Network & VPN Configuration', topics: ['Office Wi-Fi VLANs', 'Firewall rules', 'VPN troubleshooting'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Helpdesk Ticketing', topics: ['SLA targets', 'Ticket categorization', 'Shadowing senior support agent'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Software Licenses & SaaS', topics: ['Google Workspace admin', 'Slack/Zoom license provisioning', 'Password reset policy'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Backup & Security Auditing', topics: ['Weekly endpoint security checks', 'Backup verification', 'Antivirus status'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Review & Sign-Off', topics: ['Review of ticket resolution metrics', '1-on-1 manager review', 'Certification sign-off'], mandatorySignOff: true },
    ],
  },

  // ── 2. Bridal Styling ───────────────────────────────────────────────────────
  {
    roleTitle: 'Senior Bridal Stylist',
    department: 'Bridal Styling',
    trainerName: 'Farhana M.',
    overview:
      '7-day craftsmanship orientation focusing on signature bridal styling techniques, hygiene standards, saree draping, and client consultations.',
    documentContent: `# Senior Bridal Stylist — 1-Week Orientation Plan

## Overview
Welcome to the Bridal Studio team. This structured 7-day orientation equips you with our signature makeup finishes, hygiene mandates, luxury customer experience protocols, and trial-to-wedding workflows.

### Lead Trainer: Farhana M. (Studio Lead)
### Duration: 7 Days

---
### Day 1: Culture & Brand Standards
- History of Team N bridal studio aesthetic & brand ethos
- Client hospitality and luxury bridal reception walkthrough
- Kit inspection and inventory checklist setup

### Day 2: Hygiene, Safety & Tool Sterilization
- Hospital-grade sterilization for airbrush and brush sets
- Skin allergy sensitivity protocol and client consent documentation
- Workspace sanitation and OSHA/salon safety protocols

### Day 3: Client Prep & Consultation
- Bridal skin prep, toning, and primer layering techniques
- Face shape analysis and lighting compatibility evaluation
- Shadowing master artist during actual bridal consultation

### Day 4: Airbrush Mastery & Pairing
- Airbrush equipment pressure tuning and foundation diffusion
- Paired session with Senior Artist on live model
- Trainer observation and corrective blending technique feedback

### Day 5: Luxury Saree Draping & Hair Integration
- Traditional and contemporary pleating and pinning precision
- Hair accessory mounting and veil weight distribution
- Timed practice session: 45-minute complete bridal drape

### Day 6: Billing, ERP & Scheduling
- POS client invoicing, advance payments & trial package logging
- Calendar shift scheduling and travel kit logistics
- Client review capture and portfolio photography lighting

### Day 7: Final Mock Run & Sign-Off
- Complete timed bridal transformation mock session
- 1-on-1 review with Creative Director
- Trainer certification sign-off and assignment of first client booking
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Culture & Brand Standards', topics: ['Studio aesthetic & brand ethos', 'Client hospitality walkthrough', 'Kit inspection setup'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Hygiene & Tool Sterilization', topics: ['Sterilization for airbrush and brushes', 'Skin allergy protocol', 'Workspace sanitation'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Client Prep & Consultation', topics: ['Skin prep & primer layering', 'Face shape analysis', 'Shadowing master artist'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Airbrush Mastery & Pairing', topics: ['Airbrush pressure tuning', 'Paired session on live model', 'Corrective blending feedback'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Saree Draping & Hair Integration', topics: ['Contemporary pleating precision', 'Veil weight distribution', 'Timed practice run'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Billing, ERP & Scheduling', topics: ['POS client invoicing & trial packages', 'Calendar shift scheduling', 'Client reviews SOP'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Final Mock Run & Sign-Off', topics: ['Complete timed bridal transformation', '1-on-1 review with Director', 'Trainer sign-off'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'Bridal Studio Specialist',
    department: 'Bridal Styling',
    trainerName: 'Farhana M.',
    overview:
      '7-day technical skills training for studio specialists: foundation matching, color correction, eye makeup artistry, and wedding day touchup management.',
    documentContent: `# Bridal Studio Specialist — 1-Week Orientation Plan

## Overview
Comprehensive 7-day program on studio protocols, color theory, product blending, and fast bridal touch-ups.

### Lead Trainer: Farhana M.
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Studio Etiquette & Uniform', topics: ['Brand appearance standards', 'Hygiene checklist', 'Client welcoming protocol'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Color Theory & Undertones', topics: ['Warm, cool, neutral undertones', 'Color correcting dark circles and pigmentation', 'Swatch matching'], mandatorySignOff: true },
      { dayNumber: 3, title: 'HD Foundation & Contouring', topics: ['Cream vs liquid foundation blending', 'Nose and jaw contouring', 'Setting spray longevity'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Eye Artistry & Lashes', topics: ['Cut-crease techniques', 'Mink lash application', 'Smudge-proof kajal setting'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Bridal Saree Pleating Basics', topics: ['Kanchipuram silk pleat folding', 'Pin conceal techniques', 'Shoulder pallu drape'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Touch-up Kit & Venue Packing', topics: ['Emergency touch-up kit inventory', 'Outdoor wedding heat mitigation', 'Lighting check'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Live Model Evaluation', topics: ['Timed 60-min party makeup', 'Master artist review', 'Sign-off certification'], mandatorySignOff: true },
    ],
  },

  // ── 3. Academy & Training ───────────────────────────────────────────────────
  {
    roleTitle: 'Academy Head (Principal)',
    department: 'Academy & Training',
    trainerName: 'COO',
    overview:
      '7-day leadership orientation on academy curriculum governance, trainer KPIs, student accreditation standards, and admissions operations.',
    documentContent: `# Academy Head (Principal) — 1-Week Orientation Plan

## Overview
Designed to onboard the Academy Head into institutional leadership, trainer supervision, course curriculum updates, and student outcomes governance.

### Mentor: Chief Operating Officer
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Academic Vision & Accreditation', topics: ['Accreditation board standards', 'Academy mission & guidelines', 'Legal and student safety norms'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Curriculum & Pedagogy Review', topics: ['Master makeup syllabus audit', 'Hairstyling curriculum alignment', 'Practical lab hours balancing'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Trainer Governance & Audits', topics: ['Trainer classroom observation rubrics', 'Student feedback scoring systems', 'Trainer KPI calibration'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Admissions Funnel & Enrollment', topics: ['Lead-to-enrollment conversion targets', 'Fee structure & installment management', 'Batch scheduling ERP'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Masterclasses & Industry Links', topics: ['Guest celebrity educator contracts', 'Brand partnership kit sponsorships', 'Placement agency connections'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Examination & Certification', topics: ['Practical jury panel rubrics', 'Certificate printing & authentication', 'Graduation ceremony SOP'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Executive Alignment & Sign-Off', topics: ['Annual batch roadmap presentation', '1-on-1 with COO', 'Executive mandate sign-off'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'Academy Trainer',
    department: 'Academy & Training',
    trainerName: 'Academy Principal',
    overview:
      '7-day educator syllabus: stage demonstrations, classroom management, student assessment rubrics, and cosmetic chemistry instruction.',
    documentContent: `# Academy Trainer — 1-Week Orientation Plan

## Overview
Equips cosmetology educators to deliver engaging stage masterclasses, run hands-on student workshops, and grade practical exams fairly.

### Mentor: Academy Principal
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Pedagogy & Classroom Ethics', topics: ['Adult learning principles', 'Respectful student communication', 'Lab safety rules'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Lesson Planning & AV Tools', topics: ['Daily syllabus milestones', 'Projector & vanity camera setup', 'Slide deck preparation'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Live Stage Demo Standards', topics: ['Step-by-step commentary techniques', 'Time management during live demo', 'Handling student questions'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Practical Lab Supervision', topics: ['Table-to-table posture corrections', 'Tool hygiene enforcement', 'Guiding struggling students'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Rubric Scoring & ERP Grading', topics: ['Standardized grading criteria', 'Recording test marks in LMS', 'Constructive critique delivery'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Student Portfolios & Mentorship', topics: ['Lighting for student photography', 'Instagram student tag guidelines', 'Career counseling basics'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Mock Demo Lecture & Sign-Off', topics: ['Delivering 45-min demo before jury', 'Principal evaluation', 'Trainer certification granted'], mandatorySignOff: true },
    ],
  },

  // ── 4. Studio & Services Operations ─────────────────────────────────────────
  {
    roleTitle: 'Studio Operations Head',
    department: 'Studio & Services Ops',
    trainerName: 'COO',
    overview:
      '7-day operational management orientation covering multi-studio scheduling, hygiene inspections, booking escalations, and vendor supply management.',
    documentContent: `# Studio Operations Head — 1-Week Orientation Plan

## Overview
Orientation for managing day-to-day studio workflow, stylist allocation, booking surges, and 5-star customer experience.

### Mentor: Chief Operating Officer
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Multi-Studio SOPs & Standards', topics: ['Brand hygiene benchmarks', 'Opening & closing checklists', 'Facility security systems'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Artist Roster & Capacity', topics: ['Wedding season peak shift planning', 'Stylist travel dispatch logistics', 'Overtime policies'], mandatorySignOff: true },
      { dayNumber: 3, title: 'VIP Client Experience & Escalations', topics: ['High-profile bridal protocol', 'Handling last-minute cancellations', 'Service recovery SOP'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Supply Chain & Inventory', topics: ['Central warehouse replenishment', 'Product expiry audits', 'Shrinkage & breakage tracking'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Facility & Equipment Audits', topics: ['HVAC, lighting & music ambiance', 'Vanity chair ergonomics', 'Fire safety compliance'], mandatorySignOff: true },
      { dayNumber: 6, title: 'POS Daily Cash & Billing Audit', topics: ['End-of-day cash/bank register audit', 'Advance deposit reconciliation', 'Petty cash approvals'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Operational Dry Run & Sign-Off', topics: ['Full Saturday shift simulation', 'Debrief with COO', 'Management sign-off'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'Studio Assistant',
    department: 'Studio & Services Ops',
    trainerName: 'Studio Operations Head',
    overview:
      '7-day foundational orientation on tool sterilization, vanity station staging, inventory stock counting, and client hospitality.',
    documentContent: `# Studio Assistant — 1-Week Orientation Plan

## Overview
Comprehensive training on maintaining sterile studio conditions, preparing artists' stations ahead of appointments, and inventory cycle counting.

### Mentor: Studio Operations Head
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Studio Layout & Floor Etiquette', topics: ['Floor orientation & locker protocols', 'Sanitation station locations', 'Hospitality standards'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Hospital-Grade Sterilization', topics: ['Ultrasonic brush cleaners & UV box', 'Disinfectant contact times', 'Disposal of single-use disposables'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Vanity Station Preparation', topics: ['15-minute advance station setup', 'Lighting & clean mirror prep', 'Palette & brush placement'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Inventory Stock & FIFO Logging', topics: ['Daily consumable count sheets', 'First-In-First-Out restocking', 'Low-stock alerting'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Client Hospitality & Refreshments', topics: ['Bridal welcome beverage service', 'Cloakroom & gown handling', 'Restroom inspection rounds'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Between-Appointment Turnover', topics: ['5-minute rapid workstation turnover', 'Sanitizing leather styling chairs', 'Re-stocking tissues and sponges'], mandatorySignOff: false },
      { dayNumber: 7, title: 'End-to-End Prep Assessment', topics: ['Complete station prep under inspection', 'Supervisor sign-off', 'Certification badge granted'], mandatorySignOff: true },
    ],
  },

  // ── 5. Sales & Marketing ────────────────────────────────────────────────────
  {
    roleTitle: 'Client Relationship & Bridal Sales Lead',
    department: 'Sales & Marketing',
    trainerName: 'Head of Sales',
    overview:
      '7-day sales onboarding: luxury bridal package consultation, pricing strategy, CRM pipeline stages, and conversion closing techniques.',
    documentContent: `# Bridal Sales Lead — 1-Week Orientation Plan

## Overview
Master our luxury bridal service packages, client discovery consultation scripts, proposal generation, and booking contract execution.

### Mentor: Head of Sales
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Brand Value & Service Catalog', topics: ['Signature bridal makeover packages', 'Pre-wedding skin & hair rituals', 'Pricing tiers & add-ons'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Discovery Consultation Script', topics: ['Understanding bridal vision & budget', 'Venue & attire synergy questions', 'Building emotional connection'], mandatorySignOff: true },
      { dayNumber: 3, title: 'CRM Pipeline & Lead SLAs', topics: ['Lead stage updates in CRM', '15-minute inbound response SLA', 'WhatsApp consultation follow-up templates'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Quotations & Advance Booking', topics: ['Generating bespoke quotation PDF', 'Collecting 30% booking advance', 'Signing bridal contract terms'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Upselling & Bridal Party Packages', topics: ['Bridesmaids and mother-of-bride add-ons', 'Saree pre-pleating package deals', 'Trial session booking'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Handling Objections & Dates', topics: ['Negotiating peak wedding dates', 'Addressing price sensitivity with value', 'Artist preference allocation'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Mock Bridal Intake & Sign-Off', topics: ['Role-play consultation with Sales Head', 'Contract accuracy evaluation', 'Sales quota authorization'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'Digital Marketing Executive',
    department: 'Sales & Marketing',
    trainerName: 'Marketing Lead',
    overview:
      '7-day marketing orientation on social media content shoots, bridal reel editing, Meta ad lead tracking, and academy promotional campaigns.',
    documentContent: `# Digital Marketing Executive — 1-Week Orientation Plan

## Overview
Learn how to showcase our bridal transformations, manage high-performing social channels, track lead acquisition, and protect brand aesthetics.

### Mentor: Marketing Lead
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Brand Aesthetic & Visual Assets', topics: ['Color palette, font rules & logo guide', 'Cloud asset library access', 'Model consent and release forms'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Social Calendaring & Reels', topics: ['Weekly Instagram & YouTube calendar', 'Before-and-after reels transitions', 'Trending audio selection guidelines'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Studio & Wedding Live Coverage', topics: ['Studio lighting for phone video', 'Capturing delicate glitter & contour details', 'Live story posting etiquette'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Meta Ads & Lead Integration', topics: ['Ad account structure walkthrough', 'Lead form integration with CRM', 'Cost-per-lead monitoring metrics'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Academy Promotional Campaigns', topics: ['Student testimonial video formats', 'Early bird discount announcements', 'Course brochure downloads'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Influencer & Bridal Collaborations', topics: ['Influencer outreach agreements', 'Bridal expo media planning', 'Google My Business reviews campaign'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Campaign Plan Review & Sign-Off', topics: ['Presenting 30-day marketing calendar', 'Lead metrics review with Marketing Lead', 'Sign-off certification'], mandatorySignOff: true },
    ],
  },

  // ── 6. Finance & Accounts ───────────────────────────────────────────────────
  {
    roleTitle: 'Finance Head',
    department: 'Finance & Accounts',
    trainerName: 'Managing Director',
    overview:
      '7-day executive finance orientation on multi-branch cash flows, tax compliance calendars, budget governance, and audit preparation.',
    documentContent: `# Finance Head — 1-Week Orientation Plan

## Overview
Comprehensive onboarding into fiscal leadership, tax governance, cash flow forecasting, and multi-entity financial oversight.

### Mentor: Managing Director / CFO
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Entity Structure & Banking', topics: ['Corporate legal entities & bank accounts', 'Banking signatory permissions', 'Treasury & working capital overview'], mandatorySignOff: true },
      { dayNumber: 2, title: 'Cash Flow Projections & Budgets', topics: ['Studio vs Academy revenue streams', 'Monthly opex budget allocations', 'Capex authorization policy'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Statutory Tax Compliance', topics: ['GST monthly filing schedules', 'TDS deduction & quarterly returns', 'EPF & ESIC statutory norms'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Vendor Contracts & Procurement', topics: ['Cosmetics supplier payment terms', 'Studio lease agreements', 'Credit terms and vendor discounting'], mandatorySignOff: true },
      { dayNumber: 5, title: 'ERP Accounting Architecture', topics: ['Chart of accounts mapping in ERP', 'Daily POS auto-sync journals', 'Inter-branch inventory transfers'], mandatorySignOff: true },
      { dayNumber: 6, title: 'Monthly MIS Financial Reporting', topics: ['EBITDA and gross margin reporting', 'Branch P&L variance analysis', 'Board presentation deck templates'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Financial Authority Sign-Off', topics: ['Signing delegation matrix approval', 'Meeting with Managing Director', 'Sign-off and mandate grant'], mandatorySignOff: true },
    ],
  },
  {
    roleTitle: 'Senior Accountant',
    department: 'Finance & Accounts',
    trainerName: 'Finance Head',
    overview:
      '7-day accounts orientation covering POS daily reconciliation, vendor bills, GST input tax matching, and payroll register processing.',
    documentContent: `# Senior Accountant — 1-Week Orientation Plan

## Overview
Master daily accounting operations: salon POS sales recon, vendor voucher verification, GST filings, and monthly salary disbursement checks.

### Mentor: Finance Head
### Duration: 7 Days
`,
    status: 'Active',
    days: [
      { dayNumber: 1, title: 'Chart of Accounts & Tally Prime', topics: ['Account master ledger structure', 'ERP invoice sync verification', 'Petty cash register protocol'], mandatorySignOff: true },
      { dayNumber: 2, title: 'POS Daily Cash & Card Recon', topics: ['Reconciling POS settlement slips with bank', 'Advance deposits against bookings', 'Gift voucher & discount entries'], mandatorySignOff: true },
      { dayNumber: 3, title: 'Academy Fee Ledger Accounting', topics: ['Course fee installment tracking', 'Student receipt generation', 'Late fee penalty accounting'], mandatorySignOff: true },
      { dayNumber: 4, title: 'Accounts Payable & TDS Rules', topics: ['Three-way purchase order matching', 'TDS Section 194C / 194J calculation', 'Vendor payment scheduling'], mandatorySignOff: true },
      { dayNumber: 5, title: 'Payroll Register Verification', topics: ['Biometric attendance integration', 'Overtime and incentive computation', 'Salary slip disbursement checks'], mandatorySignOff: true },
      { dayNumber: 6, title: 'GST Returns (GSTR-1 & 3B)', topics: ['B2B vs B2C sales summary check', 'GSTR-2B input tax credit reconciliation', 'Tax challan payment verification'], mandatorySignOff: false },
      { dayNumber: 7, title: 'Trial Balance Closing & Sign-Off', topics: ['Month-end ledger balancing', '1-on-1 review with Finance Head', 'Audit authorization sign-off'], mandatorySignOff: true },
    ],
  },
];

const SEED_COURSES = [
  // ── Technology & Systems (IT) ─────────────────────────────────────────────
  {
    title: 'Advanced Cloud & CI/CD Pipelines',
    department: 'Technology & Systems (IT)',
    targetRole: 'Senior Dev-ops engineer',
    description: 'Modern DevOps pipelines, GitHub Actions, Kubernetes deployment strategies, infrastructure as code, and security compliance.',
    category: 'skills',
    durationHours: 12,
    active: true,
  },
  {
    title: 'Full-Stack Architecture & Flutter/Node APIs',
    department: 'Technology & Systems (IT)',
    targetRole: 'Software Engineer',
    description: 'In-depth architectural review of the Nizan ERP: Flutter state management, Express routes, Mongo query tuning, and caching.',
    category: 'skills',
    durationHours: 16,
    active: true,
  },
  {
    title: 'Enterprise Network, VPN & Hardware Security SOP',
    department: 'Technology & Systems (IT)',
    targetRole: 'IT Support Engineer',
    description: 'Office network topology, Fortinet VPN setup, MDM fleet enrolment, biometric terminal troubleshooting, and IT helpdesk SLAs.',
    category: 'compliance',
    durationHours: 8,
    active: true,
  },

  // ── Bridal Styling ────────────────────────────────────────────────────────
  {
    title: 'Bridal Artistry & Airbrush Mastery',
    department: 'Bridal Styling',
    targetRole: 'Bridal Studio Specialist',
    description: 'Signature luxury bridal makeup techniques, HD contouring, long-wear airbrush application, and skin texture prep.',
    category: 'skills',
    durationHours: 16,
    active: true,
  },
  {
    title: 'Advanced Saree Draping & Heritage Silhouettes',
    department: 'Bridal Styling',
    targetRole: 'Senior Bridal Stylist',
    description: 'Mastery in Kanchipuram silk pleating, contemporary can-can drape structuring, veil pinning, and high-speed bridal changeovers.',
    category: 'skills',
    durationHours: 10,
    active: true,
  },
  {
    title: 'VIP Bridal Consultation & Skin Texture Prep',
    department: 'Bridal Styling',
    targetRole: 'Makeup Artist Trainee',
    description: 'Comprehensive consultation protocol, bridal skin-tone undertone analysis, product patch testing, and bride anxiety de-escalation.',
    category: 'orientation',
    durationHours: 8,
    active: true,
  },

  // ── Studio & Services Ops ──────────────────────────────────────────────────
  {
    title: 'Salon Hygiene & Sterilization Standards',
    department: 'Studio & Services Ops',
    targetRole: 'Studio Floor Supervisor',
    description: 'OSHA compliance, hospital-grade equipment sanitation, client allergy screening, autoclave usage, and infection prevention protocols.',
    category: 'compliance',
    durationHours: 4,
    active: true,
  },
  {
    title: 'Studio Inventory Reorder & Asset Maintenance Protocol',
    department: 'Studio & Services Ops',
    targetRole: 'Studio Operations Executive',
    description: 'Consumables tracking, low-stock threshold triggers, vanity station hygiene audits, and vendor supply chain verification.',
    category: 'product',
    durationHours: 6,
    active: true,
  },

  // ── Academy & Training ────────────────────────────────────────────────────
  {
    title: 'Pedagogical Delivery & Practical Demonstration SOP',
    department: 'Academy & Training',
    targetRole: 'Academy Trainer',
    description: 'Instructional techniques for bridal artistry, hands-on student mentoring, micro-teaching demos, and classroom control.',
    category: 'leadership',
    durationHours: 14,
    active: true,
  },
  {
    title: 'Curriculum Pacing & Student Assessment Framework',
    department: 'Academy & Training',
    targetRole: 'Academy Assistant Trainer',
    description: 'Weekly student progress tracking, 5-point practical exam evaluation rubrics, portfolio photo reviews, and certification standards.',
    category: 'skills',
    durationHours: 10,
    active: true,
  },

  // ── Sales & Marketing ─────────────────────────────────────────────────────
  {
    title: 'Customer Experience & Consultation SOP',
    department: 'Sales & Marketing',
    targetRole: 'Bridal Sales Consultant',
    description: 'Techniques for conducting high-value consultations, handling bridal package inquiries, booking deposits, and post-wedding follow-ups.',
    category: 'orientation',
    durationHours: 6,
    active: true,
  },
  {
    title: 'Digital Campaign Management & Lead Nurturing',
    department: 'Sales & Marketing',
    targetRole: 'Digital Marketing Executive',
    description: 'Meta Ads campaign pacing, inbound bride lead triage, Instagram portfolio curation, and CRM lead conversion tracking.',
    category: 'skills',
    durationHours: 8,
    active: true,
  },

  // ── Finance & Accounts ────────────────────────────────────────────────────
  {
    title: 'Team N ERP & Billing POS Operations',
    department: 'Finance & Accounts',
    targetRole: 'Billing Cashier',
    description: 'Complete walkthrough of point of sale, split payment handling, advance deposits, daily shift reconciliation, and cash drawer handovers.',
    category: 'skills',
    durationHours: 6,
    active: true,
  },
  {
    title: 'GST Returns, TDS Deductions & Ledger Reconciliation',
    department: 'Finance & Accounts',
    targetRole: 'Finance & Accounts Executive',
    description: 'GSTR-1 and 3B preparation, TDS 194C/194J calculations, 3-way invoice matching, and bank reconciliation statements.',
    category: 'compliance',
    durationHours: 12,
    active: true,
  },

  // ── HR & People Operations ────────────────────────────────────────────────
  {
    title: 'Company Code of Conduct, POSH & Statutory HR Policies',
    department: 'HR & People Operations',
    targetRole: 'All Employees',
    description: 'Prevention of Sexual Harassment (POSH) compliance, confidentiality, workplace ethics, leave policies, and grievance escalation mechanisms.',
    category: 'compliance',
    durationHours: 4,
    active: true,
  },
  {
    title: '5-Pillar Evaluation Framework & Mentorship SOP',
    department: 'HR & People Operations',
    targetRole: 'Department Lead',
    description: 'Conducting quarterly 5-pillar performance reviews, probationary milestones, PIP design, and structured career ladder progression.',
    category: 'leadership',
    durationHours: 8,
    active: true,
  },
];

const getOrientationPlans = asyncHandler(async (req, res) => {
  // Ensure all seeded plans exist in the database with up-to-date 7-day syllabi
  for (const seed of SEED_ORIENTATION_PLANS) {
    await OrientationPlan.updateOne(
      { roleTitle: seed.roleTitle },
      {
        $set: {
          department: seed.department,
          trainerName: seed.trainerName,
          overview: seed.overview,
          documentContent: seed.documentContent,
          days: seed.days,
          status: seed.status,
        },
      },
      { upsert: true }
    );
  }

  const plans = await OrientationPlan.find({}).sort({ department: 1, roleTitle: 1 });
  res.json(plans);
});

const createOrientationPlan = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
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

const getActiveOrientations = asyncHandler(async (req, res) => {
  let list = await OrientationAssignment.find({}).sort({ createdAt: -1 });

  // Auto-seed active orientation for Lionel Messi if none exists
  if (list.length === 0) {
    const messi = await Employee.findOne({ name: 'Lionel Messi' });
    if (messi) {
      const plan = await OrientationPlan.findOne({ roleTitle: { $regex: /dev-ops/i } });
      const days = (plan?.days || SEED_ORIENTATION_PLANS[0].days).map((d) => ({
        dayNumber: d.dayNumber,
        title: d.title,
        topics: d.topics,
        signedOff: d.dayNumber <= 3,
        signedOffBy: d.dayNumber <= 3 ? 'Infra Lead' : '',
        signedOffAt: d.dayNumber <= 3 ? new Date() : null,
        status: d.dayNumber <= 3 ? 'Signed' : (d.dayNumber === 4 ? 'In progress' : 'Upcoming'),
      }));
      await OrientationAssignment.create({
        employeeId: messi._id,
        employeeName: messi.name,
        roleTitle: messi.role || 'Senior Dev-ops engineer',
        department: messi.department || 'Technology & Systems (IT)',
        trainerName: 'Infrastructure Lead',
        planId: plan?._id || null,
        currentDay: 4,
        totalDays: 7,
        status: 'On track',
        days,
      });
      list = await OrientationAssignment.find({}).sort({ createdAt: -1 });
    }
  }

  // Ensure Lionel Messi's active progress is calibrated (Days 1-3 signed, Day 4 in progress)
  const messiAsgn = list.find((a) => a.employeeName === 'Lionel Messi');
  if (messiAsgn && messiAsgn.days.every((d) => d.signedOff)) {
    messiAsgn.currentDay = 4;
    messiAsgn.days.forEach((d) => {
      d.signedOff = d.dayNumber <= 3;
      d.signedOffBy = d.dayNumber <= 3 ? 'Infra Lead' : '';
      d.signedOffAt = d.dayNumber <= 3 ? (d.signedOffAt || new Date()) : null;
      d.status = d.dayNumber <= 3 ? 'Signed' : (d.dayNumber === 4 ? 'In progress' : 'Upcoming');
    });
    await messiAsgn.save();
  }

  // Seed Kavya S. Nair for Bridal Styling if not already present
  const kavyaAsgn = list.find((a) => a.employeeName?.includes('Kavya'));
  if (!kavyaAsgn) {
    const kavyaEmp = await Employee.findOne({ name: { $regex: /Kavya/i } });
    const bridalPlan = await OrientationPlan.findOne({ roleTitle: { $regex: /bridal stylist/i } });
    if (kavyaEmp && bridalPlan) {
      const days = bridalPlan.days.map((d) => ({
        dayNumber: d.dayNumber,
        title: d.title,
        topics: d.topics,
        signedOff: d.dayNumber <= 2,
        signedOffBy: d.dayNumber <= 2 ? 'Farhana M.' : '',
        signedOffAt: d.dayNumber <= 2 ? new Date() : null,
        status: d.dayNumber <= 2 ? 'Signed' : (d.dayNumber === 3 ? 'In progress' : 'Upcoming'),
      }));
      await OrientationAssignment.create({
        employeeId: kavyaEmp._id,
        employeeName: kavyaEmp.name,
        roleTitle: kavyaEmp.role || 'Senior Bridal Stylist',
        department: 'Bridal Styling',
        trainerName: 'Farhana M.',
        planId: bridalPlan._id,
        currentDay: 3,
        totalDays: 7,
        status: 'On track',
        days,
      });
      list = await OrientationAssignment.find({}).sort({ createdAt: -1 });
    }
  }

  res.json(list);
});

const assignOrientation = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const { employeeId, planId } = req.body;
  if (!employeeId) { res.status(400); throw new Error('Employee required'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  let plan = planId ? await OrientationPlan.findById(planId) : null;
  if (!plan) {
    plan = await OrientationPlan.findOne({
      $or: [{ roleTitle: employee.role }, { department: employee.department }],
    });
  }

  const daysTemplate = plan?.days || SEED_ORIENTATION_PLANS[0].days;
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
    trainerName: plan?.trainerName || req.body.trainerName || 'Department Lead',
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

  await assignment.save();
  res.json(assignment);
});

// Auto-seed / sync courses across departments
const originalGetCourses = getCourses;
const ensureCoursesSeeded = asyncHandler(async (req, res, next) => {
  for (const c of SEED_COURSES) {
    try {
      await Course.updateOne(
        { title: c.title },
        {
          $set: {
            title: c.title,
            department: c.department,
            targetRole: c.targetRole,
            description: c.description,
            category: c.category,
            durationHours: c.durationHours,
            active: c.active !== false,
          },
        },
        { upsert: true }
      );
    } catch (err) {
      console.warn('Skipping course sync item:', err.message);
    }
  }
  return originalGetCourses(req, res, next);
});

export {
  ensureCoursesSeeded as getCourses,
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
  getActiveOrientations,
  assignOrientation,
  updateOrientationProgress,
};
