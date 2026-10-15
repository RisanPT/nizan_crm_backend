import mongoose from 'mongoose';

export const ONBOARDING_STATUSES = ['in_progress', 'completed'];

export const DEFAULT_ONBOARDING_TASKS = [
  'Offer letter signed',
  'ID & address proof uploaded',
  'Welcome email sent',
  'Buddy assigned',
  'Bank & PF details collected',
  'Kit & workstation ready',
  'Day-1 orientation booked',
];

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    done: { type: Boolean, default: false },
    owner: { type: String, default: '' },
    dueDate: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { _id: false }
);

// A new hire's onboarding checklist. Auto-created when an offer is accepted.
const onboardingSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    role: { type: String, default: '' },
    joiningDate: { type: Date, default: null },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Candidate', default: null },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Offer', default: null },
    startedOn: { type: Date, default: Date.now },
    completedOn: { type: Date, default: null },
    status: { type: String, enum: ONBOARDING_STATUSES, default: 'in_progress' },
    tasks: { type: [taskSchema], default: [] },
    documents: {
      type: [
        {
          name: { type: String, default: '' },
          owner: { type: String, default: '' },
          required: { type: Boolean, default: true },
          status: { type: String, default: 'Pending' }, // 'Received', 'Pending', 'Not required'
        },
      ],
      default: [
        { name: 'Signed offer letter', required: true, status: 'Received' },
        { name: 'Aadhaar & PAN', required: true, status: 'Pending' },
        { name: 'Bank account proof', required: true, status: 'Pending' },
        { name: 'Previous experience letter', required: false, status: 'Not required' },
        { name: 'Education certificates', required: true, status: 'Pending' },
      ],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const Onboarding = mongoose.model('Onboarding', onboardingSchema);
export default Onboarding;
