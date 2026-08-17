import mongoose from 'mongoose';

// One planning record per month — the targets the CEO sets in the first-working-
// day planning meeting, which the Month-End Review then measures actuals against.
// Budget ALLOCATION per department is kept here too (planning intent), separate
// from the Budget collection which drives the operational budget-vs-actual by
// expense category.
const monthlyTargetSchema = mongoose.Schema(
  {
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    // Headline targets (₹).
    revenueTarget: { type: Number, default: 0 },
    profitTarget: { type: Number, default: 0 },
    collectionTarget: { type: Number, default: 0 },
    expenseLimit: { type: Number, default: 0 },

    // Department/function budget allocation for the month, e.g.
    // [{ name: 'Marketing', amount: 50000 }, { name: 'HR', amount: 120000 }].
    allocations: [
      {
        name: { type: String, required: true },
        amount: { type: Number, default: 0 },
        _id: false,
      },
    ],

    notes: { type: String, default: '' },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One planning record per month/year.
monthlyTargetSchema.index({ month: 1, year: 1 }, { unique: true });

const MonthlyTarget = mongoose.model('MonthlyTarget', monthlyTargetSchema);

export default MonthlyTarget;
