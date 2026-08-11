import asyncHandler from 'express-async-handler';
import AccountReport from '../models/AccountReport.js';
import { cloudinary } from '../config/cloudinary.js';
import { Readable } from 'stream';

const fileTypeOf = (name = '') => {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext.startsWith('xls')) return 'excel';
  if (ext === 'csv') return 'csv';
  return 'other';
};

/// Upload a raw (PDF / Excel / CSV) buffer to Cloudinary; resolves with result.
function uploadRaw(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: 'team_n_crm/reports',
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    Readable.from(buffer).pipe(stream);
  });
}

/// Best-effort removal of a raw file from Cloudinary given its secure_url.
async function destroyRaw(fileUrl) {
  if (!fileUrl) return;
  try {
    const parts = fileUrl.split('/');
    const i = parts.indexOf('team_n_crm');
    if (i !== -1) {
      // For raw files the public_id includes the folder path + extension.
      const publicId = parts.slice(i).join('/');
      await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    }
  } catch (err) {
    console.error('Failed to delete file from Cloudinary:', err);
  }
}

const isAdmin = (user) => user?.role === 'admin';

/// Parse a `sharedWith` payload into a clean array of id strings. Accepts a real
/// array (JSON body), repeated form fields, a JSON-encoded string, or a
/// comma-separated string — whatever the multipart/JSON client sends.
const parseSharedWith = (raw) => {
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

/// Whether [user] is allowed to view [report]: the uploader, anyone in
/// sharedWith, or an admin.
const canView = (report, user) => {
  if (isAdmin(user)) return true;
  const me = String(user._id);
  if (String(report.uploadedBy?._id ?? report.uploadedBy) === me) return true;
  return (report.sharedWith || []).some(
    (u) => String(u?._id ?? u) === me,
  );
};

/// Only the uploader or an admin may modify a report (rename/replace, change
/// access, or delete).
const isOwnerOrAdmin = (report, user) =>
  isAdmin(user) || String(report.uploadedBy?._id ?? report.uploadedBy) === String(user._id);

// @desc    Upload an account report
// @route   POST /api/account-reports
// @access  Private (accounts team via the app's RBAC)
const uploadReport = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('No file uploaded');
  }
  const title = (req.body.title || '').trim();
  if (!title) {
    res.status(400);
    throw new Error('Please provide a title for the report');
  }

  const result = await uploadRaw(req.file.buffer);
  const report = new AccountReport({
    title,
    fileUrl: result.secure_url,
    fileType: fileTypeOf(req.file.originalname),
    fileName: req.file.originalname || '',
    uploadedBy: req.user._id,
    // Optional list of viewers chosen at upload time (never includes the owner,
    // who always has access). Empty = private to the uploader.
    sharedWith: parseSharedWith(req.body.sharedWith).filter(
      (id) => id !== String(req.user._id),
    ),
  });
  await report.save();
  // Populate the uploader so the client gets the same shape as GET (which
  // groups reports by uploader name) — otherwise uploadedBy is a bare id.
  await report.populate('uploadedBy', 'name email');
  await report.populate('sharedWith', 'name email');
  res.status(201).json(report);
});

// @desc    Get account reports the current user is allowed to see.
//          Admins see everything; everyone else sees only what they uploaded
//          or what was explicitly shared with them.
// @route   GET /api/account-reports
// @access  Private
const getReports = asyncHandler(async (req, res) => {
  const filter = isAdmin(req.user)
    ? {}
    : { $or: [{ uploadedBy: req.user._id }, { sharedWith: req.user._id }] };

  const reports = await AccountReport.find(filter)
    .populate('uploadedBy', 'name email')
    .populate('sharedWith', 'name email')
    .sort({ createdAt: -1 });
  res.json(reports);
});

// @desc    Modify a report — rename the title and/or replace the file
// @route   PUT /api/account-reports/:id
// @access  Private
const updateReport = asyncHandler(async (req, res) => {
  const report = await AccountReport.findById(req.params.id);
  if (!report) {
    res.status(404);
    throw new Error('Report not found');
  }
  if (!isOwnerOrAdmin(report, req.user)) {
    res.status(403);
    throw new Error('Only the uploader can modify this report');
  }

  const title = (req.body.title || '').trim();
  if (title) report.title = title;

  if (req.file) {
    // Replace the file: upload the new one, then remove the old from Cloudinary.
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
  res.json(report);
});

// @desc    Replace a report's access list (who may view it).
// @route   PUT /api/account-reports/:id/access
// @access  Private (uploader or admin only)
const updateReportAccess = asyncHandler(async (req, res) => {
  const report = await AccountReport.findById(req.params.id);
  if (!report) {
    res.status(404);
    throw new Error('Report not found');
  }
  if (!isOwnerOrAdmin(report, req.user)) {
    res.status(403);
    throw new Error('Only the uploader can change who can view this report');
  }

  // Never store the owner in their own share list — they always have access.
  report.sharedWith = parseSharedWith(req.body.sharedWith).filter(
    (id) => id !== String(report.uploadedBy),
  );
  await report.save();

  await report.populate('uploadedBy', 'name email');
  await report.populate('sharedWith', 'name email');
  res.json(report);
});

const MIME_BY_TYPE = {
  pdf: 'application/pdf',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

const extByType = { pdf: 'pdf', excel: 'xlsx', csv: 'csv' };

// @desc    Stream a report's file through the API with correct headers.
//          Avoids Cloudinary raw-delivery quirks (missing extension / inline
//          content-type) that made direct downloads open as "undefined format".
// @route   GET /api/account-reports/:id/download
// @access  Private
const downloadReport = asyncHandler(async (req, res) => {
  const report = await AccountReport.findById(req.params.id);
  if (!report || !report.fileUrl) {
    res.status(404);
    throw new Error('Report not found');
  }
  if (!canView(report, req.user)) {
    res.status(403);
    throw new Error('You do not have access to this report');
  }

  const upstream = await fetch(report.fileUrl);
  if (!upstream.ok) {
    res.status(502);
    throw new Error(
      `Could not fetch the stored file (HTTP ${upstream.status}). ` +
        'If this is a PDF, enable "Allow delivery of PDF and ZIP files" in Cloudinary settings.',
    );
  }

  const mime = MIME_BY_TYPE[report.fileType] || 'application/octet-stream';
  const ext = extByType[report.fileType] || 'bin';
  const safeName = (report.fileName && report.fileName.trim())
    ? report.fileName.trim()
    : `${(report.title || 'report').replace(/[^\w.-]+/g, '_')}.${ext}`;

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName.replace(/"/g, '')}"`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
});

// @desc    Delete an account report (and its Cloudinary file)
// @route   DELETE /api/account-reports/:id
// @access  Private
const deleteReport = asyncHandler(async (req, res) => {
  const report = await AccountReport.findById(req.params.id);
  if (!report) {
    res.status(404);
    throw new Error('Report not found');
  }
  if (!isOwnerOrAdmin(report, req.user)) {
    res.status(403);
    throw new Error('Only the uploader can delete this report');
  }
  await destroyRaw(report.fileUrl);
  await report.deleteOne();
  res.json({ message: 'Report removed' });
});

export {
  uploadReport,
  getReports,
  updateReport,
  updateReportAccess,
  downloadReport,
  deleteReport,
};
