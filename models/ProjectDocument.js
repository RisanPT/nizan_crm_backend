import mongoose from 'mongoose';

// One version of a project document — bundles the editable DOC and/or the
// exported PDF for that revision.
const versionSchema = mongoose.Schema(
  {
    version: { type: Number, required: true },
    pdfUrl: { type: String, default: '' },
    pdfName: { type: String, default: '' },
    docUrl: { type: String, default: '' },
    docName: { type: String, default: '' },
    notes: { type: String, default: '' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: { type: String, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// A versioned document attached to an IT project (SRS, design doc, API spec, …).
const projectDocumentSchema = mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    title: { type: String, required: true, trim: true },
    docType: { type: String, enum: ['srs', 'design', 'api', 'other'], default: 'srs' },
    description: { type: String, default: '' },
    versions: { type: [versionSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

const ProjectDocument = mongoose.model('ProjectDocument', projectDocumentSchema);

export default ProjectDocument;
