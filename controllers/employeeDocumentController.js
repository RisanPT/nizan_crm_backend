import asyncHandler from 'express-async-handler';
import { Readable } from 'stream';
import EmployeeDocument from '../models/EmployeeDocument.js';
import { cloudinary } from '../config/cloudinary.js';
import { getHrScope, isHrWide } from '../utils/hrDeptScope.js';

// HR-wide callers (admin/manager, `staff`/`hr_files` permission, head of HR)
// manage every employee's documents. Other department heads manage only the
// documents of their own department's employees. An employee (ESS) may
// view/upload their OWN documents, matched via their linked User.employeeId.
const KEYS = ['hr_files'];

const ownEmployeeId = (user) => (user?.employeeId ? String(user.employeeId) : '');

// True when the caller may manage documents belonging to `employeeId`.
// Personal documents (Aadhaar, PAN, certificates…) stay with HR-wide users
// only — department heads never had access to other people's files, and the
// department-scoping decision doesn't change that.
const canManageDocsOf = async (req, _employeeId) => isHrWide(req, KEYS);

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
      { resource_type: 'raw', folder: 'team_n_crm/employee_documents', use_filename: true, unique_filename: true },
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
    console.error('Failed to delete employee document from Cloudinary:', err);
  }
}

// @route GET /api/employee-documents?employeeId=
// HR managers may list any employee's docs (or all with no filter). An employee
// only ever sees their own, regardless of the query.
const getDocuments = asyncHandler(async (req, res) => {
  let filter = {};
  const scope = await getHrScope(req, KEYS);
  const me = ownEmployeeId(req.user);
  if (scope.wide) {
    if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  } else {
    if (!me) return res.json([]);
    filter.employeeId = me;
  }
  const docs = await EmployeeDocument.find(filter)
    .populate('employeeId', 'name department')
    .sort({ createdAt: -1 })
    .lean();
  res.json(docs);
});

// @route POST /api/employee-documents  (multipart: file + fields)
const uploadDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('No file uploaded');
  }
  const employeeId = String(req.body.employeeId || '').trim();
  const title = String(req.body.title || '').trim();
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  if (!title) { res.status(400); throw new Error('Please provide a title'); }

  // Employees may only upload against their own record.
  if (employeeId !== ownEmployeeId(req.user) && !(await canManageDocsOf(req, employeeId))) {
    res.status(403);
    throw new Error('You can only upload your own documents');
  }

  const result = await uploadRaw(req.file.buffer);
  const doc = await EmployeeDocument.create({
    employeeId,
    category: String(req.body.category || 'other').trim(),
    title,
    description: String(req.body.description || '').trim(),
    expiresOn: req.body.expiresOn ? new Date(req.body.expiresOn) : null,
    fileUrl: result.secure_url,
    fileType: fileTypeOf(req.file.originalname),
    fileName: req.file.originalname || '',
    uploadedBy: req.user?._id || null,
    uploadedByName: req.user?.name || '',
  });
  await doc.populate('employeeId', 'name department');
  res.status(201).json(doc);
});

const canModify = async (doc, req) =>
  String(doc.uploadedBy || '') === String(req.user._id) || canManageDocsOf(req, doc.employeeId);

// @route PUT /api/employee-documents/:id
const updateDocument = asyncHandler(async (req, res) => {
  const doc = await EmployeeDocument.findById(req.params.id);
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  if (!(await canModify(doc, req))) { res.status(403); throw new Error('Not authorized to modify this document'); }

  const b = req.body;
  if (b.title !== undefined && String(b.title).trim()) doc.title = String(b.title).trim();
  if (b.category !== undefined) doc.category = String(b.category).trim() || 'other';
  if (b.description !== undefined) doc.description = String(b.description).trim();
  if (b.expiresOn !== undefined) doc.expiresOn = b.expiresOn ? new Date(b.expiresOn) : null;

  if (req.file) {
    const oldUrl = doc.fileUrl;
    const result = await uploadRaw(req.file.buffer);
    doc.fileUrl = result.secure_url;
    doc.fileType = fileTypeOf(req.file.originalname);
    doc.fileName = req.file.originalname || doc.fileName;
    await doc.save();
    await destroyRaw(oldUrl);
  } else {
    await doc.save();
  }
  await doc.populate('employeeId', 'name department');
  res.json(doc);
});

const MIME_BY_TYPE = {
  pdf: 'application/pdf',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  image: 'image/jpeg',
};
const extByType = { pdf: 'pdf', excel: 'xlsx', csv: 'csv', word: 'docx', image: 'jpg' };

const canView = async (doc, req) =>
  String(doc.employeeId?._id ?? doc.employeeId) === ownEmployeeId(req.user) ||
  canManageDocsOf(req, doc.employeeId);

// @route GET /api/employee-documents/:id/download  (?inline=1 to render)
const downloadDocument = asyncHandler(async (req, res) => {
  const doc = await EmployeeDocument.findById(req.params.id);
  if (!doc || !doc.fileUrl) { res.status(404); throw new Error('Document not found'); }
  if (!(await canView(doc, req))) { res.status(403); throw new Error('You do not have access to this document'); }

  const upstream = await fetch(doc.fileUrl);
  if (!upstream.ok) {
    res.status(502);
    throw new Error(`Could not fetch the stored file (HTTP ${upstream.status}).`);
  }
  const mime = MIME_BY_TYPE[doc.fileType] || 'application/octet-stream';
  const ext = extByType[doc.fileType] || 'bin';
  const safeName = (doc.fileName && doc.fileName.trim())
    ? doc.fileName.trim()
    : `${(doc.title || 'document').replace(/[^\w.-]+/g, '_')}.${ext}`;
  const buf = Buffer.from(await upstream.arrayBuffer());
  const disposition =
    String(req.query.inline || '') === '1' || req.query.inline === 'true' ? 'inline' : 'attachment';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

// @route DELETE /api/employee-documents/:id
const deleteDocument = asyncHandler(async (req, res) => {
  const doc = await EmployeeDocument.findById(req.params.id);
  if (!doc) { res.status(404); throw new Error('Document not found'); }
  if (!(await canModify(doc, req))) { res.status(403); throw new Error('Not authorized to delete this document'); }
  await destroyRaw(doc.fileUrl);
  await doc.deleteOne();
  res.json({ message: 'Document removed', id: req.params.id });
});

export {
  getDocuments,
  uploadDocument,
  updateDocument,
  downloadDocument,
  deleteDocument,
};
