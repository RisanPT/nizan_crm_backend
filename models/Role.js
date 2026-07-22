import mongoose from 'mongoose';

/// Canonical list of feature modules that can be granted to a role.
/// Keep in sync with lib/core/auth/app_permissions.dart on the Flutter side.
export const PERMISSION_KEYS = [
  'dashboard',
  'clients',
  'calendar',
  'bookings',
  'trials',
  'services',
  'staff',
  'sales',
  'finance',
  'payables',
  'inventory',
  'marketing',
  'fleet',
  'reports',
  'leave',
  'settings',
];

const roleSchema = new mongoose.Schema(
  {
    // Stable slug stored on User.role (e.g. 'sales', 'regional_manager').
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    // Landing page after login for this role.
    homeRoute: {
      type: String,
      default: '/',
      trim: true,
    },
    // System roles cannot be deleted or renamed (they carry special
    // behaviour elsewhere, e.g. artist scoping and driver screens).
    isSystem: {
      type: Boolean,
      default: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Role', roleSchema);
