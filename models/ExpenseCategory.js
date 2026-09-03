import mongoose from 'mongoose';

// The default categories seeded for a department the first time its category
// list is opened. Kept as the same slug values the app shipped with, so any
// existing expenses that stored these values still line up with the seeded
// categories. New custom categories are stored as the head types them.
export const DEFAULT_EXPENSE_CATEGORIES = [
  'office_supplies',
  'rent_utilities',
  'travel_transport',
  'food_beverage',
  'staff_mess',
  'hardware_equipment',
  'marketing_ads',
  'professional_services',
  'maintenance',
  'training',
  'staff_welfare',
  'other',
];

// A per-department expense category. Each department head owns (CRUD) their own
// department's list; Accounts/Admin can manage any department's. Delete is a
// SOFT delete (active:false) so historical expenses keep their label and the
// defaults are not silently re-seeded after a department clears its list.
const expenseCategorySchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a category name'],
      trim: true,
    },
    department: {
      type: String,
      required: [true, 'A category must belong to a department'],
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

// One category name per department (case-insensitive is enforced in the
// controller before insert; this guards exact duplicates).
expenseCategorySchema.index({ department: 1, name: 1 }, { unique: true });

const ExpenseCategory = mongoose.model('ExpenseCategory', expenseCategorySchema);

export default ExpenseCategory;
