import mongoose from 'mongoose';

// What needs the CEO / Executive Director to decide, set by hand (Settings → Decision rules). OFF until someone sets it: a blank limit
// means nothing is escalated by amount, and the hiring switch starts off — so deploying changes nothing. Singleton, like
// AccountingSetting. (The rules that read it are in utils/decisionRules.js.)
const policyChangeSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const decisionPolicySchema = new mongoose.Schema(
  {
    // One row only: the unique key stops two requests from creating two.
    key: { type: String, default: 'default', unique: true },
    // ₹ — an item ABOVE this goes to leadership once the team has checked it. null = off.
    spendLimits: {
      expense: { type: Number, default: null }, // a department expense
      payout: { type: Number, default: null }, // an artist payout
      projectBudget: { type: Number, default: null }, // an INCREASE of a project's approved budget (a first approval counts from zero)
    },
    hiringPlansNeedLeadership: { type: Boolean, default: false },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
    history: { type: [policyChangeSchema], default: [] },
  },
  { timestamps: true },
);

const DecisionPolicy = mongoose.model('DecisionPolicy', decisionPolicySchema);
export default DecisionPolicy;
