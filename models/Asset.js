import mongoose from 'mongoose';

// Company asset register — both digital (domains, licenses, social accounts…)
// and physical (equipment, furniture, vehicles…). Lives under the Finance
// section, separate from consumable studio Inventory.
export const ASSET_TYPES = ['digital', 'physical'];
export const ASSET_STATUSES = [
  'active',
  'in_use',
  'idle',
  'maintenance',
  'disposed',
  'expired',
];
// Straight-line (equal each year) or written-down-value (reducing balance).
export const DEPRECIATION_METHODS = ['straight_line', 'wdv'];

const assetSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add an asset name'],
      trim: true,
    },
    assetType: {
      type: String,
      enum: ASSET_TYPES,
      required: true,
    },
    // Free-text-ish category (client sends one of the suggested lists per type).
    category: { type: String, default: 'other', trim: true },
    // Current / acquisition value, and how many units this record covers.
    value: { type: Number, default: 0, min: 0 },
    quantity: { type: Number, default: 1, min: 0 },
    purchaseDate: { type: Date, default: null },
    status: { type: String, enum: ASSET_STATUSES, default: 'active' },
    // Who is responsible for the asset (denormalized name + optional link).
    custodian: { type: String, default: '', trim: true },
    custodianEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    // ── Physical-only ──
    location: { type: String, default: '', trim: true },
    condition: { type: String, default: '', trim: true }, // new | good | fair | poor
    serialNumber: { type: String, default: '', trim: true },
    // ── Digital-only ──
    provider: { type: String, default: '', trim: true }, // registrar / platform
    url: { type: String, default: '', trim: true },
    // Renewal / expiry date for digital assets (domains, licenses).
    expiryDate: { type: Date, default: null },
    notes: { type: String, default: '', trim: true },
    // ── Depreciation ──
    // When enabled, the monthly depreciation run writes off this asset's cost
    // (value) over its life and keeps `accumulatedDepreciation` up to date.
    depreciable: { type: Boolean, default: false },
    depreciationMethod: {
      type: String,
      enum: DEPRECIATION_METHODS,
      default: 'straight_line',
    },
    // Annual depreciation rate in % (required for WDV; optional for SLM if a
    // useful life is given instead).
    depreciationRate: { type: Number, default: 0, min: 0, max: 100 },
    // Useful life in years (SLM alternative to a rate).
    usefulLifeYears: { type: Number, default: 0, min: 0 },
    // Residual value the asset is never written below.
    salvageValue: { type: Number, default: 0, min: 0 },
    // When depreciation begins (defaults to purchaseDate at run time).
    depreciationStart: { type: Date, default: null },
    // Running total written off so far — maintained by the depreciation run.
    accumulatedDepreciation: { type: Number, default: 0, min: 0 },
    lastDepreciatedOn: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

const Asset = mongoose.model('Asset', assetSchema);

export default Asset;
