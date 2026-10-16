import mongoose from 'mongoose';

export const LETTER_TYPES = ['offer', 'experience', 'salary_certificate', 'noc', 'confirmation', 'warning', 'other'];

// A reusable HR-letter template. `body` holds placeholders like {{name}},
// {{designation}}, {{department}}, {{date}}, {{salary}}, {{joiningDate}} that the
// generator fills from the chosen employee.
const letterTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: LETTER_TYPES, default: 'other' },
    body: { type: String, default: '' },
    content: { type: String, default: '' },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

letterTemplateSchema.pre('save', function (next) {
  if (!this.body && this.content) this.body = this.content;
  if (!this.content && this.body) this.content = this.body;
  next();
});

const LetterTemplate = mongoose.model('LetterTemplate', letterTemplateSchema);
export default LetterTemplate;
