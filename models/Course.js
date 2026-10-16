import mongoose from 'mongoose';

export const COURSE_CATEGORIES = ['orientation', 'skills', 'compliance', 'leadership', 'product', 'management', 'other'];

// A learning course / module (LMS). `url` points at the resource (video, doc,
// external link). Employees enrol and track progress via Enrollment.
const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: { type: String, enum: COURSE_CATEGORIES, default: 'skills' },
    department: { type: String, default: 'General', trim: true },
    targetRole: { type: String, default: '', trim: true },
    url: { type: String, default: '' },
    durationHours: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Course = mongoose.model('Course', courseSchema);
export default Course;
