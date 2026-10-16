import mongoose from 'mongoose';

// Per-employee document vault entry (the HRMS "Files" module): ID proofs,
// contracts, certificates, offer/experience letters, etc. Each row FKs to
// Employee._id and stores one Cloudinary raw file. Access is HR-admin + the
// employee themselves (resolved via User.employeeId).
export const DOCUMENT_CATEGORIES = [
  'id_proof',
  'contract',
  'certificate',
  'offer_letter',
  'experience_letter',
  'resume',
  'payslip',
  'other',
];

const employeeDocumentSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: DOCUMENT_CATEGORIES,
      default: 'other',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    fileUrl: { type: String, default: '' },
    fileType: { type: String, default: 'other' }, // pdf | image | word | excel | csv | other
    fileName: { type: String, default: '' },
    expiresOn: { type: Date, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const EmployeeDocument = mongoose.model('EmployeeDocument', employeeDocumentSchema);

export default EmployeeDocument;
