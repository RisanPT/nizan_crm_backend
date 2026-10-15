import mongoose from 'mongoose';

// A letter produced for an employee from a template (placeholders filled). The
// filled `body` is stored so it can be viewed / downloaded later.
const generatedLetterSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'LetterTemplate', default: null },
    type: { type: String, default: 'other' },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    issuedOn: { type: Date, default: Date.now },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    issuedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const GeneratedLetter = mongoose.model('GeneratedLetter', generatedLetterSchema);
export default GeneratedLetter;
