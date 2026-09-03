import asyncHandler from 'express-async-handler';
import { Readable } from 'stream';
import CompanyReport from '../models/CompanyReport.js';
import ReportFolder from '../models/ReportFolder.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { cloudinary } from '../config/cloudinary.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';
import { notify, NOTIFICATION_TYPES } from '../utils/notify.js';

// Notify the head(s) of the department a report was filed under — so a
// department head sees every document submitted to their department. Heads are
// found by the `isDepartmentHead` flag on the department's users, plus the
// department's designated `head` Employee's login user. Best-effort.
const notifyDepartmentHeads = async (departmentName, actor, report) => {
  if (!departmentName) return;
  try {
    const dept = await Department.findOne({ name: departmentName })
      .select('_id head')
      .lean();
    if (!dept) return;

    const ids = new Set();
    const heads = await User.find({
      departmentId: dept._id,
      isDepartmentHead: true,
    })
      .select('_id')
      .lean();
    heads.forEach((u) => ids.add(String(u._id)));

    if (dept.head) {
      const headUser = await User.findOne({ employeeId: dept.head })
        .select('_id')
        .lean();
      if (headUser) ids.add(String(headUser._id));
    }

    const recipients = [...ids].filter((id) => id !== String(actor?._id));
    if (recipients.length === 0) return;

    await notify({
      recipients,
      type: NOTIFICATION_TYPES.REPORT_UPLOADED,
      title: 'New report in your department',
      body: `${actor?.name || 'Someone'} uploaded "${report.title}" to ${departmentName}.`,
      link: '/company-reports',
      createdBy: actor?._id ?? null,
      excludeUserId: actor?._id ?? null,
    });
  } catch (err) {
    console.error('notifyDepartmentHeads failed:', err.message);
  }
};

const fileTypeOf = (name = '') => {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext.startsWith('xls')) return 'excel';
  if (ext === 'csv') return 'csv';
  if (['doc', 'docx'].includes(ext)) return 'word';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'image';
  return 'other';
};

function uploadRaw(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'team_n_crm/company_reports', use_filename: true, unique_filename: true },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function destroyRaw(fileUrl) {
  if (!fileUrl) return;
  try {
    const parts = fileUrl.split('/');
    const i = parts.indexOf('team_n_crm');
    if (i !== -1) {
      await cloudinary.uploader.destroy(parts.slice(i).join('/'), { resource_type: 'raw' });
    }
  } catch (err) {
    console.error('Failed to delete file from Cloudinary:', err);
  }
}

const isFullAccess = (u) => ['admin', 'manager'].includes(String(u?.role || '').toLowerCase());

const parseList = (raw) => {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = s.split(',');
    }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))];
};

// Resolve the requesting user's department NAME. Uses the shared resolver
// (User.departmentId → linked Employee), so a head without a departmentId is
// still recognised. Returns null when no department can be resolved.
const userDeptName = async (user) => (await resolveUserDeptName(user)) || null;

const isOwnerOrAdmin = (report, user) =>
  isFullAccess(user) || String(report.uploadedBy?._id ?? report.uploadedBy) === String(user._id);

// A report may only be filed in a folder of its OWN department. Returns the
// folder id when valid, else null (Unfiled).
const normalizeFolder = async (folderId, department) => {
  if (!folderId) return null;
  const folder = await ReportFolder.findById(folderId).select('department').lean();
  if (!folder) return null;
  if (String(folder.department).trim() !== String(department).trim()) return null;
  return folderId;
};

// @route POST /api/company-reports
const uploadReport = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('No file uploaded');
  }
  const title = (req.body.title || '').trim();
  const department = (req.body.department || '').trim();
  if (!title) { res.status(400); throw new Error('Please provide a title'); }
  if (!department) { res.status(400); throw new Error('Please choose a department'); }

  const result = await uploadRaw(req.file.buffer);
  const uploaderDepartment = (await userDeptName(req.user)) || '';
  const report = new CompanyReport({
    title,
    description: (req.body.description || '').trim(),
    department,
    folder: await normalizeFolder(req.body.folder, department),
    period: (req.body.period || '').trim(),
    fileUrl: result.secure_url,
    fileType: fileTypeOf(req.file.originalname),
    fileName: req.file.originalname || '',
    uploadedBy: req.user._id,
    uploaderDepartment,
    visibleToRoles: parseList(req.body.visibleToRoles),
    sharedWith: parseList(req.body.sharedWith).filter((id) => id !== String(req.user._id)),
  });
  await report.save();
  await report.populate('uploadedBy', 'name email');
  await report.populate('sharedWith', 'name email');
  await report.populate('folder', 'name department');

  // Let the department head know a report was submitted to their department.
  await notifyDepartmentHeads(report.department, req.user, report);

  res.status(201).json(report);
});

// @route GET /api/company-reports?department=
// Admins/managers see all; everyone else sees their department's reports, plus
// reports shared to their role or to them personally, plus their own uploads.
const getReports = asyncHandler(async (req, res) => {
  const dept = await userDeptName(req.user);
  const scopeTeam = req.query.scope === 'team';

  let filter = {};
  if (scopeTeam) {
    // A department head's separate view of everything their TEAM uploaded
    // (keyed by the uploader's department, not the report's filed department).
    filter = dept ? { uploaderDepartment: dept } : { _id: { $in: [] } };
  } else if (!isFullAccess(req.user)) {
    const or = [
      { uploadedBy: req.user._id },
      { sharedWith: req.user._id },
      { visibleToRoles: String(req.user.role || '') },
    ];
    if (dept) {
      or.push({ uploaderDepartment: dept });
    }
    filter = { $or: or };
  }
  if (req.query.department && req.query.department !== 'All') {
    filter = Object.keys(filter).length === 0
      ? { department: req.query.department }
      : { $and: [filter, { department: req.query.department }] };
  }

  const reports = await CompanyReport.find(filter)
    .populate('uploadedBy', 'name email')
    .populate('sharedWith', 'name email')
    .populate('folder', 'name department')
    .sort({ createdAt: -1 });
  res.json(reports);
});

// @route PUT /api/company-reports/:id  — rename / re-file / replace file
const updateReport = asyncHandler(async (req, res) => {
  const report = await CompanyReport.findById(req.params.id);
  if (!report) { res.status(404); throw new Error('Report not found'); }
  if (!isOwnerOrAdmin(report, req.user)) { res.status(403); throw new Error('Only the uploader can modify this report'); }

  const b = req.body;
  if (b.title !== undefined && b.title.trim()) report.title = b.title.trim();
  if (b.description !== undefined) report.description = b.description.trim();
  if (b.department !== undefined && b.department.trim()) report.department = b.department.trim();
  // Folder is validated against the report's (possibly just-changed) department.
  if (b.folder !== undefined) {
    report.folder = await normalizeFolder(b.folder, report.department);
  }
  if (b.period !== undefined) report.period = b.period.trim();
  if (b.visibleToRoles !== undefined) report.visibleToRoles = parseList(b.visibleToRoles);
  if (b.sharedWith !== undefined) {
    report.sharedWith = parseList(b.sharedWith).filter((id) => id !== String(report.uploadedBy));
  }

  if (req.file) {
    const oldUrl = report.fileUrl;
    const result = await uploadRaw(req.file.buffer);
    report.fileUrl = result.secure_url;
    report.fileType = fileTypeOf(req.file.originalname);
    report.fileName = req.file.originalname || report.fileName;
    await report.save();
    await destroyRaw(oldUrl);
  } else {
    await report.save();
  }
  await report.populate('uploadedBy', 'name email');
  await report.populate('sharedWith', 'name email');
  await report.populate('folder', 'name department');
  res.json(report);
});

const MIME_BY_TYPE = {
  pdf: 'application/pdf',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  image: 'image/jpeg',
};
const extByType = { pdf: 'pdf', excel: 'xlsx', csv: 'csv', word: 'docx', image: 'jpg' };

const canView = async (report, user) => {
  if (isFullAccess(user)) return true;
  const me = String(user._id);
  if (String(report.uploadedBy?._id ?? report.uploadedBy) === me) return true;
  if ((report.sharedWith || []).some((u) => String(u?._id ?? u) === me)) return true;
  if ((report.visibleToRoles || []).includes(String(user.role || ''))) return true;
  const dept = await userDeptName(user);
  return !!dept && dept === report.uploaderDepartment;
};

// @route GET /api/company-reports/:id/download
const downloadReport = asyncHandler(async (req, res) => {
  const report = await CompanyReport.findById(req.params.id);
  if (!report || !report.fileUrl) { res.status(404); throw new Error('Report not found'); }
  if (!(await canView(report, req.user))) { res.status(403); throw new Error('You do not have access to this report'); }

  const upstream = await fetch(report.fileUrl);
  if (!upstream.ok) {
    res.status(502);
    throw new Error(`Could not fetch the stored file (HTTP ${upstream.status}).`);
  }
  const mime = MIME_BY_TYPE[report.fileType] || 'application/octet-stream';
  const ext = extByType[report.fileType] || 'bin';
  const safeName = (report.fileName && report.fileName.trim())
    ? report.fileName.trim()
    : `${(report.title || 'report').replace(/[^\w.-]+/g, '_')}.${ext}`;
  const buf = Buffer.from(await upstream.arrayBuffer());
  // ?inline=1 → render in the browser / in-app viewer instead of forcing a save.
  const disposition =
    String(req.query.inline || '') === '1' || req.query.inline === 'true'
      ? 'inline'
      : 'attachment';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

// @route DELETE /api/company-reports/:id
const deleteReport = asyncHandler(async (req, res) => {
  const report = await CompanyReport.findById(req.params.id);
  if (!report) { res.status(404); throw new Error('Report not found'); }
  if (!isOwnerOrAdmin(report, req.user)) { res.status(403); throw new Error('Only the uploader can delete this report'); }
  await destroyRaw(report.fileUrl);
  await report.deleteOne();
  res.json({ message: 'Report removed' });
});

// ── Folders ──────────────────────────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const canManageFolder = (folder, user) =>
  isFullAccess(user) || String(folder.createdBy ?? '') === String(user._id);

// @route GET /api/company-reports/folders?department=Sales
// Folders for a department. Non-full-access users only ever see their own.
const listFolders = asyncHandler(async (req, res) => {
  let department = (req.query.department || '').trim();
  // Any authenticated user may list a given department's folders (folder names
  // are organisational labels, not sensitive data). With none specified,
  // default to the caller's own department.
  if (!department || department === 'All') {
    department = (await userDeptName(req.user)) || '__none__';
  }
  const folders = await ReportFolder.find({ department }).sort({ name: 1 }).lean();
  res.json(folders);
});

// @route POST /api/company-reports/folders  { name, department }
const createFolder = asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide a folder name'); }

  let department = (req.body.department || '').trim();
  if (!isFullAccess(req.user)) {
    // A department member may only create folders for their OWN department.
    department = (await userDeptName(req.user)) || '';
  }
  if (!department) { res.status(400); throw new Error('Please choose a department'); }

  const existing = await ReportFolder.findOne({
    department,
    name: { $regex: `^${escapeRe(name)}$`, $options: 'i' },
  });
  if (existing) { res.status(409); throw new Error('That folder already exists for this department'); }

  const folder = await ReportFolder.create({ name, department, createdBy: req.user._id });
  res.status(201).json(folder);
});

// @route PUT /api/company-reports/folders/:id  { name }
const updateFolder = asyncHandler(async (req, res) => {
  const folder = await ReportFolder.findById(req.params.id);
  if (!folder) { res.status(404); throw new Error('Folder not found'); }
  if (!canManageFolder(folder, req.user)) { res.status(403); throw new Error('Not authorized to rename this folder'); }

  const name = (req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide a folder name'); }
  const clash = await ReportFolder.findOne({
    _id: { $ne: folder._id },
    department: folder.department,
    name: { $regex: `^${escapeRe(name)}$`, $options: 'i' },
  });
  if (clash) { res.status(409); throw new Error('Another folder with that name already exists'); }

  folder.name = name;
  await folder.save();
  res.json(folder);
});

// @route DELETE /api/company-reports/folders/:id — its reports become Unfiled.
const deleteFolder = asyncHandler(async (req, res) => {
  const folder = await ReportFolder.findById(req.params.id);
  if (!folder) { res.status(404); throw new Error('Folder not found'); }
  if (!canManageFolder(folder, req.user)) { res.status(403); throw new Error('Not authorized to delete this folder'); }

  await CompanyReport.updateMany({ folder: folder._id }, { $set: { folder: null } });
  await folder.deleteOne();
  res.json({ message: 'Folder removed' });
});

export {
  uploadReport,
  getReports,
  updateReport,
  downloadReport,
  deleteReport,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
};
