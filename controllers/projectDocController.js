import { Readable } from 'stream';
import ProjectDocument from '../models/ProjectDocument.js';
import Project from '../models/Project.js';
import { cloudinary } from '../config/cloudinary.js';
import { buildProjectScope, canViewProject, canManageProject } from '../utils/projectAccess.js';

// Load the project a document belongs to and confirm the caller's access.
// `mode` is 'view' (any project member) or 'manage' (manager / dept head /
// leadership). Sends the 404/403 response and returns null on failure.
const checkDocAccess = async (req, res, projectId, mode = 'view') => {
  if (!projectId) {
    res.status(400).json({ message: 'projectId is required' });
    return null;
  }
  const project = await Project.findById(projectId);
  if (!project) {
    res.status(404).json({ message: 'Project not found' });
    return null;
  }
  const allowed = mode === 'manage'
    ? await canManageProject(req.user, project)
    : await canViewProject(req.user, project);
  if (!allowed) {
    res.status(403).json({
      message: mode === 'manage'
        ? 'Only project managers can change documents'
        : 'You do not have access to this project',
    });
    return null;
  }
  return project;
};

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Stream a memory buffer to Cloudinary as a raw file (same as company reports).
function uploadRaw(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'team_n_crm/project_docs', use_filename: true, unique_filename: true },
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
    if (i !== -1) await cloudinary.uploader.destroy(parts.slice(i).join('/'), { resource_type: 'raw' });
  } catch (err) {
    console.error('ProjectDoc Cloudinary delete failed:', err.message);
  }
}

const nextVersionNumber = (doc) => doc.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;

// GET /api/project-docs?projectId=  — any member of the project.
export const getProjectDocs = async (req, res) => {
  try {
    if (req.query.projectId) {
      if (!(await checkDocAccess(req, res, req.query.projectId, 'view'))) return;
      const docs = await ProjectDocument.find({ projectId: req.query.projectId }).sort({ createdAt: -1 });
      return res.json(docs);
    }
    // No project filter: return docs only for projects the caller can view.
    const scope = await buildProjectScope(req.user);
    const ids = await Project.find(scope).distinct('_id');
    const docs = await ProjectDocument.find({ projectId: { $in: ids } }).sort({ createdAt: -1 });
    res.json(docs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/project-docs  — project managers only. Creates the document shell.
export const createProjectDoc = async (req, res) => {
  try {
    const { projectId, title, docType, description } = req.body;
    if (!projectId || !title) return res.status(400).json({ message: 'projectId and title are required' });
    if (!(await checkDocAccess(req, res, projectId, 'manage'))) return;
    const doc = await ProjectDocument.create({
      projectId,
      title: String(title).trim(),
      docType: docType || 'srs',
      description: description || '',
      createdBy: req.user._id,
      createdByName: req.user.name || '',
    });
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /api/project-docs/:id  — project managers only. Edit metadata (not files).
export const updateProjectDoc = async (req, res) => {
  try {
    const doc = await ProjectDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    if (!(await checkDocAccess(req, res, doc.projectId, 'manage'))) return;
    for (const k of ['title', 'docType', 'description']) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    await doc.save();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /api/project-docs/:id/versions  (multipart: pdf, doc)  — managers only.
export const uploadVersion = async (req, res) => {
  try {
    const doc = await ProjectDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    if (!(await checkDocAccess(req, res, doc.projectId, 'manage'))) return;

    const pdfFile = req.files?.pdf?.[0];
    const docFile = req.files?.doc?.[0];
    if (!pdfFile && !docFile) return res.status(400).json({ message: 'Attach a PDF and/or a DOC file' });

    const version = {
      version: nextVersionNumber(doc),
      notes: req.body.notes || '',
      uploadedBy: req.user._id,
      uploadedByName: req.user.name || '',
      uploadedAt: new Date(),
    };
    if (pdfFile) {
      const r = await uploadRaw(pdfFile.buffer);
      version.pdfUrl = r.secure_url;
      version.pdfName = pdfFile.originalname;
    }
    if (docFile) {
      const r = await uploadRaw(docFile.buffer);
      version.docUrl = r.secure_url;
      version.docName = docFile.originalname;
    }
    doc.versions.push(version);
    await doc.save();
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/project-docs/:id/versions/:version/download?fmt=pdf|doc&inline=1
export const downloadVersion = async (req, res) => {
  try {
    const doc = await ProjectDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    if (!(await checkDocAccess(req, res, doc.projectId, 'view'))) return;
    const v = doc.versions.find((x) => String(x.version) === String(req.params.version));
    if (!v) return res.status(404).json({ message: 'Version not found' });

    const fmt = String(req.query.fmt || 'pdf').toLowerCase() === 'doc' ? 'doc' : 'pdf';
    const url = fmt === 'doc' ? v.docUrl : v.pdfUrl;
    const name = fmt === 'doc' ? v.docName : v.pdfName;
    if (!url) return res.status(404).json({ message: `No ${fmt.toUpperCase()} file for this version` });

    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ message: `Could not fetch the stored file (HTTP ${upstream.status}).` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const safeBase = (doc.title || 'document').replace(/[^\w.-]+/g, '_');
    const safeName = name && name.trim() ? name.trim() : `${safeBase}_v${v.version}.${fmt === 'doc' ? 'docx' : 'pdf'}`;
    const disposition = String(req.query.inline || '') === '1' || req.query.inline === 'true' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', MIME[fmt]);
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/project-docs/:id/versions/:version  — managers only.
export const deleteVersion = async (req, res) => {
  try {
    const doc = await ProjectDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    if (!(await checkDocAccess(req, res, doc.projectId, 'manage'))) return;
    const v = doc.versions.find((x) => String(x.version) === String(req.params.version));
    if (!v) return res.status(404).json({ message: 'Version not found' });
    await destroyRaw(v.pdfUrl);
    await destroyRaw(v.docUrl);
    doc.versions = doc.versions.filter((x) => String(x.version) !== String(req.params.version));
    await doc.save();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /api/project-docs/:id  — managers only. Removes the doc + all files.
export const deleteProjectDoc = async (req, res) => {
  try {
    const doc = await ProjectDocument.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    if (!(await checkDocAccess(req, res, doc.projectId, 'manage'))) return;
    for (const v of doc.versions) {
      await destroyRaw(v.pdfUrl);
      await destroyRaw(v.docUrl);
    }
    await doc.deleteOne();
    res.json({ message: 'Document deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
