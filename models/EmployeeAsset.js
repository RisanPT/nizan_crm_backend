import mongoose from 'mongoose';

// Company property handed to an EMPLOYEE (laptop, phone, kit, uniform, ID card,
// SIM…) and whether it came back. Not to be confused with models/Asset.js,
// which is the FINANCE fixed-asset register. An exit can't be completed while
// any of these is still 'issued' (see offboardingController).
export const EMPLOYEE_ASSET_CATEGORIES = ['laptop', 'phone', 'kit', 'uniform', 'id_card', 'sim', 'other'];
export const EMPLOYEE_ASSET_STATUSES = ['issued', 'returned', 'lost'];

const employeeAssetSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    item: { type: String, required: true, trim: true },
    category: { type: String, enum: EMPLOYEE_ASSET_CATEGORIES, default: 'other' },
    serialNo: { type: String, default: '', trim: true },
    issuedOn: { type: Date, default: Date.now },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    issuedByName: { type: String, default: '' },
    condition: { type: String, default: '', trim: true },
    returnedOn: { type: Date, default: null },
    returnedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    returnedToName: { type: String, default: '' },
    returnCondition: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    status: { type: String, enum: EMPLOYEE_ASSET_STATUSES, default: 'issued', index: true },
  },
  { timestamps: true }
);

employeeAssetSchema.index({ employeeId: 1, status: 1 });

const EmployeeAsset = mongoose.model('EmployeeAsset', employeeAssetSchema);
export default EmployeeAsset;
