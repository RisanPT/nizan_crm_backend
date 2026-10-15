import mongoose from 'mongoose';

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

// Auto-generate employeeCode before first save if not explicitly assigned
employeeSchema.pre('save', async function (next) {
  if (!this.employeeCode) {
    try {
      const count = await mongoose.models.Employee.countDocuments();
      let num = 1001 + count;
      let candidate = `NZ-${num}`;
      while (await mongoose.models.Employee.exists({ employeeCode: candidate })) {
        num += 1;
        candidate = `NZ-${num}`;
      }
      this.employeeCode = candidate;
    } catch (err) {
      this.employeeCode = `NZ-${Math.floor(1000 + Math.random() * 9000)}`;
    }
  }
  next();
});

const Employee = mongoose.model('Employee', employeeSchema);

export default Employee;
