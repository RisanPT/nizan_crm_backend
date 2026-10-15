import asyncHandler from 'express-async-handler';
import LetterTemplate from '../models/LetterTemplate.js';
import GeneratedLetter from '../models/GeneratedLetter.js';
import Employee from '../models/Employee.js';
import Designation from '../models/Designation.js';

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('hr_letters') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage HR letters');
  }
};

const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(dt.getDate()).padStart(2, '0')} ${m[dt.getMonth()]} ${dt.getFullYear()}`;
};

// Fill {{placeholders}} from the employee + a few extras.
const fillTemplate = (body, map) =>
  String(body || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => (map[key] != null ? String(map[key]) : ''));

// ── Templates ────────────────────────────────────────────────────────────────
const getTemplates = asyncHandler(async (_req, res) => {
  const rows = await LetterTemplate.find({}).sort({ name: 1 }).lean();
  res.json(rows);
});

const seedLetterTemplates = asyncHandler(async (req, res) => {
  guard(req, res);
  const defaults = [
    {
      name: 'Standard Offer of Employment',
      type: 'offer',
      body: `We are pleased to extend an offer of employment for the position of {{designation}} in the {{department}} Department at Nizan Beauty Ventures Private Limited ("Nizan Makeovers").

Your skills, creative experience, and professional background make you an exceptional addition to our studio team. We are confident that you will make valuable contributions to our luxury bridal and creative event production standards.

1. Designation & Role:
You will be appointed as {{designation}}, reporting to the Department Head / Creative Director at our Kozhikode studio.

2. Compensation:
Your total Monthly Gross Cost to Company (CTC) will be INR {{salary}}/- subject to applicable statutory deductions.

3. Probation & Confirmation:
You will be on probation for a period of 3 months from your joining date ({{joiningDate}}). Upon successful performance evaluation, your employment will be confirmed in writing.

4. Working Hours & Confidentiality:
You will adhere to studio operational hours and strict client confidentiality protocols. All creative portfolios, styling formulas, and client records remain the exclusive property of Nizan Beauty Ventures Pvt. Ltd.

Please sign and return the duplicate copy of this letter as confirmation of your acceptance. We look forward to welcoming you to the Nizan family!`,
    },
    {
      name: 'Experience & Relieving Certificate',
      type: 'experience',
      body: `TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{name}} was employed with Nizan Beauty Ventures Private Limited as {{designation}} in the {{department}} Department from {{joiningDate}} to {{date}}.

During their tenure with us, {{name}} demonstrated exemplary professionalism, creative expertise, and dedication to our studio standards. They were relieved of their duties at the close of business hours on {{date}} following satisfactory completion of all exit handover procedures.

We appreciate their contributions to our organization and wish them all the best in their future endeavors.`,
    },
    {
      name: 'Salary Certificate',
      type: 'salary_certificate',
      body: `TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{name}} (Employee ID: {{employeeId}}) is a bonafide employee of Nizan Beauty Ventures Private Limited, currently working as {{designation}} in the {{department}} Department since {{joiningDate}}.

As per our payroll records, their current gross compensation is INR {{salary}}/- per month.

This certificate is issued at the specific request of the employee for banking / official purposes without any financial liability on part of the company.`,
    },
    {
      name: 'No Objection Certificate (NOC)',
      type: 'noc',
      body: `TO WHOMSOEVER IT MAY CONCERN

This is to certify that Nizan Beauty Ventures Private Limited has no objection to {{name}}, working with us as {{designation}} in the {{department}} Department, pursuing their requested official / educational certification or travel during their sanctioned leave period.

This NOC is issued on {{date}} upon the request of the employee.`,
    },
    {
      name: 'Letter of Confirmation',
      type: 'confirmation',
      body: `Dear {{name}},

Following the review of your performance during your probation period, we are pleased to inform you that your employment with Nizan Beauty Ventures Private Limited as {{designation}} in the {{department}} Department stands confirmed with effect from {{date}}.

All other terms and conditions of your employment contract remain unchanged. We congratulate you on your confirmation and look forward to your continued excellence and dedication with Nizan Makeovers.`,
    },
  ];

  for (const item of defaults) {
    const exists = await LetterTemplate.findOne({ name: item.name });
    if (!exists) {
      await LetterTemplate.create({
        ...item,
        createdBy: req.user?._id || null,
      });
    }
  }

  const rows = await LetterTemplate.find({}).sort({ name: 1 }).lean();
  res.status(201).json(rows);
});

const createTemplate = asyncHandler(async (req, res) => {
  guard(req, res);
  const name = String(req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please add a template name'); }
  const bodyText = String(req.body.body || req.body.content || '');
  const row = await LetterTemplate.create({
    name,
    type: req.body.type || 'other',
    body: bodyText,
    content: bodyText,
    active: req.body.active !== false,
    createdBy: req.user?._id || null,
  });
  res.status(201).json(row);
});

const updateTemplate = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await LetterTemplate.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Template not found'); }
  const b = req.body;
  if (b.name !== undefined && String(b.name).trim()) row.name = String(b.name).trim();
  if (b.type !== undefined) row.type = b.type;
  if (b.body !== undefined) {
    row.body = String(b.body);
    row.content = String(b.body);
  } else if (b.content !== undefined) {
    row.body = String(b.content);
    row.content = String(b.content);
  }
  if (b.active !== undefined) row.active = Boolean(b.active);
  await row.save();
  res.json(row);
});

const deleteTemplate = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await LetterTemplate.findByIdAndDelete(req.params.id);
  if (!row) { res.status(404); throw new Error('Template not found'); }
  res.json({ message: 'Template removed', id: req.params.id });
});

// ── Generated letters ────────────────────────────────────────────────────────
const getGenerated = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  const rows = await GeneratedLetter.find(filter)
    .populate('employeeId', 'name department')
    .sort({ createdAt: -1 })
    .limit(300);
  res.json(rows);
});

// @route POST /api/letters/generate  { templateId | body, employeeId, subject?, salary? }
const generateLetter = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  let templateBody = String(req.body.body || req.body.content || '');
  let type = req.body.type || 'other';
  let templateId = null;
  let templateName = '';
  if (req.body.templateId) {
    const tpl = await LetterTemplate.findById(req.body.templateId);
    if (!tpl) { res.status(404); throw new Error('Template not found'); }
    templateBody = String(tpl.body || tpl.content || '');
    type = tpl.type;
    templateId = tpl._id;
    templateName = tpl.name || '';
  }
  if (!templateBody.trim()) { res.status(400); throw new Error('Provide a template or body'); }

  let designationName = employee.role || '';
  if (employee.designationId) {
    const des = await Designation.findById(employee.designationId).select('name').lean();
    if (des?.name) designationName = des.name;
  }

  const map = {
    name: employee.name || '',
    employeeName: employee.name || '',
    employeeId: String(employee._id),
    designation: designationName,
    department: employee.department || '',
    email: employee.email || '',
    phone: employee.phone || '',
    salary: employee.baseSalary || 0,
    date: fmtDate(new Date()),
    joiningDate: fmtDate(employee.createdAt),
    company: 'Nizan Makeovers',
    ...(req.body.extra && typeof req.body.extra === 'object' ? req.body.extra : {}),
  };

  const filled = fillTemplate(templateBody, map);
  const fallbackSubject = templateName ? `${templateName} - ${employee.name || ''}` : `HR Letter - ${employee.name || ''}`;
  const letter = await GeneratedLetter.create({
    employeeId: employee._id,
    employeeName: employee.name,
    templateId,
    type,
    subject: String(req.body.subject || '').trim() || fallbackSubject,
    body: filled,
    issuedBy: req.user?._id || null,
    issuedByName: req.user?.name || '',
  });
  await letter.populate('employeeId', 'name department');
  res.status(201).json(letter);
});

const deleteGenerated = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await GeneratedLetter.findByIdAndDelete(req.params.id);
  if (!row) { res.status(404); throw new Error('Letter not found'); }
  res.json({ message: 'Letter removed', id: req.params.id });
});

export {
  getTemplates,
  seedLetterTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getGenerated,
  generateLetter,
  deleteGenerated,
};

