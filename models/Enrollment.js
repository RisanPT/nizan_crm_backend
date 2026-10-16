import mongoose from 'mongoose';

export const ENROLLMENT_STATUSES = ['enrolled', 'in_progress', 'completed'];

// An employee's enrolment in a course, with progress tracking.
const enrollmentSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    courseTitle: { type: String, default: '' },
    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'enrolled' },
    progress: { type: Number, default: 0 }, // 0..100
    enrolledOn: { type: Date, default: Date.now },
    completedOn: { type: Date, default: null },
  },
  { timestamps: true }
);

enrollmentSchema.index({ employeeId: 1, courseId: 1 }, { unique: true });

const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
export default Enrollment;
