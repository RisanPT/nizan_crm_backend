import mongoose from 'mongoose';

export const DIVISIONS = ['administrative', 'creative'];

// The 9 seed departments grouped by division. `key` is a stable slug used by
// code (e.g. the departmental month-end reports); admins can add more.
export const SEED_DEPARTMENTS = [
  { key: 'it', name: 'IT', division: 'administrative' },
  { key: 'accounts', name: 'Accounts', division: 'administrative' },
  { key: 'hr', name: 'HR', division: 'administrative' },
  { key: 'sales', name: 'Sales', division: 'administrative' },
  { key: 'finance', name: 'Finance', division: 'administrative' },
  { key: 'marketing', name: 'Marketing', division: 'administrative' },
  { key: 'crm', name: 'CRM', division: 'administrative' },
  { key: 'artist', name: 'Artist', division: 'creative' },
  { key: 'fleet', name: 'Fleet', division: 'creative' },
];

// A first-class department. Grouped into an Administrative or Creative division.
// Carries the delegation boundary (`allowedRoleKeys` — the roles this
// department's head may assign to their team) and the geography scope (empty =
// PAN-India / all) used by the geo-scoping phase.
const departmentSchema = mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    division: { type: String, enum: DIVISIONS, default: 'administrative' },
    description: { type: String, default: '' },

    // The department head — an Employee (staff record), so Timebox-imported staff
    // without a login can be heads too. The delegation phase resolves the head's
    // login User via the Employee↔User link.
    head: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },

    // Delegation boundary: Role.key values the head may grant to team members.
    allowedRoleKeys: { type: [String], default: [] },

    // Geography scope (for the geo-scoping phase). Empty arrays = all / PAN-India.
    zoneIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }],
    stateIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'State' }],
    regionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Region' }],

    active: { type: Boolean, default: true },
    // Seed departments cannot be deleted (only deactivated) so code keys stay valid.
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Department = mongoose.model('Department', departmentSchema);

export default Department;
