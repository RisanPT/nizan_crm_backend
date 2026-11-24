import mongoose from 'mongoose';
import Counter from './Counter.js';

const employeeSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
      default: '',
    },
    profileImage: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['in-house', 'outsource', 'full-time', 'contract'],
      default: 'in-house',
    },
    // An outside ARTIST who works a bride's event as an associate (helps the lead artist), paid per work through Artist Payouts. Always an
    // outsource person: no login, no payroll. Operations adds them while assigning a work; the Associate Works report lists what they did.
    isAssociate: {
      type: Boolean,
      default: false,
    },
    artistRole: {
      type: String,
      enum: ['artist', 'assistant', 'driver', 'staff', 'other'],
      default: 'artist',
    },
    specialization: {
      type: String,
      default: '',
    },
    works: {
      type: [String],
      default: [],
    },
    phone: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Zone',
      default: null,
    },
    stateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'State',
      default: null,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      default: null,
    },
    pincodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pincode',
      default: null,
    },
    role: {
      type: String,
      default: '',
    },
    department: {
      type: String,
      default: 'Operations',
    },
    // Link to the Department entity (org structure). Set on Timebox import and
    // when a member is assigned to a department.
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      default: null,
    },
    // Reporting manager (another Employee). Drives the leave/approval chain and
    // the org-hierarchy view. Falls back to the department head when unset.
    reportingManagerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    // HRMS job role this person was hired into (Recruitment -> Job Roles). Its
    // crmRoleKey is pre-selected when HR issues the login.
    jobRoleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobRole',
      default: null,
    },
    // Formal designation/title (optional). `role` stays as the free-text label.
    designationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Designation',
      default: null,
    },
    category: {
      type: String,
      enum: ['operations', 'administrative', 'creative', 'it', 'marketing', 'sales', 'admin'],
      default: 'operations',
    },
    salaryType: {
      type: String,
      enum: ['fixed_monthly', 'per_booking', 'daily', 'hybrid', 'commission'],
      default: 'fixed_monthly',
    },
    baseSalary: {
      type: Number,
      default: 0,
      min: 0,
    },
    allowances: {
      type: Number,
      default: 0,
      min: 0,
    },
    deductions: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Monthly House Rent Allowance configured for this employee. Paid via the
    // separate HRA screen (Accounts) — NOT bundled into the salary slip.
    hra: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Recurring day-of-month (1–31) on which this employee's HRA is due. Used to
    // auto-fill the payment date in the HRA screen for the current month. 0 = not set.
    hraDay: {
      type: Number,
      default: 0,
      min: 0,
      max: 31,
    },
    bankName: {
      type: String,
      default: '',
      trim: true,
    },
    accountNumber: {
      type: String,
      default: '',
      trim: true,
    },
    ifscCode: {
      type: String,
      default: '',
      trim: true,
    },
    upiId: {
      type: String,
      default: '',
      trim: true,
    },
    panNumber: {
      type: String,
      default: '',
      trim: true,
    },
    // ── Timebox attendance software link ──────────────────────────────────────
    // Populated by POST /api/timebox/sync-employees. Once set, this is the
    // primary match key (beats email + name) so renames never break payroll.
    timeboxEmployeeId: {
      type: Number,
      default: null,
    },
    timeboxName: {
      type: String,
      default: '',
      trim: true,
    },
    // ── SRS §3.2 & §4.1 Mandatory Employee Master Fields ─────────────────────
    // Human-readable, unique, immutable ID (FR-2.1)
    employeeCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    dateOfBirth: {
      type: Date,
      default: null,
    },
    dateOfJoining: {
      type: Date,
      default: Date.now,
    },
    probationEndDate: {
      type: Date,
      default: null,
    },
    employmentStatus: {
      type: String,
      enum: ['probation', 'confirmed', 'notice_period', 'exited'],
      default: 'probation',
    },
    // Set when an offboarding is completed (last working day).
    exitDate: {
      type: Date,
      default: null,
    },
    emergencyContact: {
      name: { type: String, default: '', trim: true },
      relation: { type: String, default: '', trim: true },
      phone: { type: String, default: '', trim: true },
    },
    currentGrade: {
      type: String,
      enum: ['A', 'B', 'C', 'D'],
      default: 'B',
    },
    overtimeRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    statutoryApplicability: {
      epf: { type: Boolean, default: false },
      esi: { type: Boolean, default: false },
      uan: { type: String, default: '', trim: true },
      esiNumber: { type: String, default: '', trim: true },
    },
  },
  {
    timestamps: true,
  }
);

// ── employeeCode: NZ-1001, NZ-1002, … ────────────────────────────────────────
// Every number is drawn from ONE atomic counter ({ _id: 'employeeCode' } in `counters`, $inc), so employees saved at the same moment —
// an HR create, an associate quick-add, a Timebox import — can never be handed the same code. (It used to be "1001 + how many employees
// there are", which two saves at once both read the same.) A number that is already taken — typed in by hand, or given out before the
// counter existed — is skipped, never handed out again; numbers are never reused, so a skipped or failed save just leaves a gap.
const CODE_COUNTER = 'employeeCode';
const FIRST_CODE = 1001;
const MAX_DRAWS = 10000;

export async function nextEmployeeCode(EmployeeModel = mongoose.models.Employee) {
  for (let i = 0; i < MAX_DRAWS; i += 1) {
    let seq;
    try {
      ({ seq } = await Counter.findOneAndUpdate({ _id: CODE_COUNTER }, { $inc: { seq: 1 } }, { new: true, upsert: true, lean: true }));
    } catch (err) {
      if (err?.code === 11000) continue; // two first-ever draws raced to create the counter: draw again
      throw err;
    }
    if (seq < FIRST_CODE) {
      // A new (or lost) counter: start it where the count-based numbering stood — after the employees already there. Raising it with $max
      // is safe however many draws do this at once; any number in the range that is already taken is skipped below.
      const already = await EmployeeModel.countDocuments();
      await Counter.updateOne({ _id: CODE_COUNTER }, { $max: { seq: FIRST_CODE - 1 + already } });
      continue;
    }
    const code = `NZ-${seq}`;
    if (!(await EmployeeModel.exists({ employeeCode: code }))) return code;
  }
  throw new Error('Could not find a free employee code.');
}

// Give a code on the first save if none was typed in. A failure fails the save — a made-up code could belong to someone else.
employeeSchema.pre('save', async function () {
  if (!this.employeeCode) this.employeeCode = await nextEmployeeCode(this.constructor);
});

employeeSchema.statics.nextEmployeeCode = function () {
  return nextEmployeeCode(this);
};

const Employee = mongoose.model('Employee', employeeSchema);

export default Employee;
