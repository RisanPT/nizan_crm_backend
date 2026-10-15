import mongoose from 'mongoose';

const daySchema = new mongoose.Schema(
  {
    dayNumber: { type: Number, required: true }, // 1 to 7
    title: { type: String, required: true },
    topics: [{ type: String }],
    mandatorySignOff: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { _id: false }
);

// 1-Week Job Role Orientation Plan
const orientationPlanSchema = new mongoose.Schema(
  {
    roleTitle: { type: String, required: true, trim: true, index: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobRole', default: null },
    department: { type: String, required: true, trim: true },
    trainerName: { type: String, default: 'Department Lead' },
    overview: {
      type: String,
      default:
        'Structured 7-day technical & operational onboarding plan designed to ramp up the new hire smoothly from initial setup to autonomous execution.',
    },
    documentUrl: { type: String, default: '' },
    documentContent: {
      type: String,
      default: '',
    },
    status: { type: String, enum: ['Active', 'Draft'], default: 'Active' },
    days: {
      type: [daySchema],
      default: [
        {
          dayNumber: 1,
          title: 'Culture, Values & System Setup',
          topics: [
            'Company mission, culture & brand values walkthrough',
            'Workstation & credentials setup (SSO, ERP, Slack, VPN)',
            'HR policies, attendance & compliance briefing',
          ],
          mandatorySignOff: true,
        },
        {
          dayNumber: 2,
          title: 'Hygiene, Tooling & Architecture',
          topics: [
            'Architecture overview & codebase / salon standards',
            'Tooling, linters & safety protocol compliance',
            'Access verification for cloud infra, staging & repos',
          ],
          mandatorySignOff: true,
        },
        {
          dayNumber: 3,
          title: 'Workflows & Shadowing',
          topics: [
            'End-to-end service / release lifecycle walkthrough',
            'Shadowing senior lead on active production task / client prep',
            'Incident & escalation workflow review',
          ],
          mandatorySignOff: true,
        },
        {
          dayNumber: 4,
          title: 'Core Execution & Pairing',
          topics: [
            'First small ticket / feature / styling session assigned',
            'Paired execution with buddy / mentor',
            'Code review / craftsmanship QA checklist review',
          ],
          mandatorySignOff: true,
        },
        {
          dayNumber: 5,
          title: 'Independent Task & Practice',
          topics: [
            'Independent delivery of assigned sub-task',
            'Testing in staging / trial run with mentor observation',
            'Debrief & continuous feedback notes',
          ],
          mandatorySignOff: true,
        },
        {
          dayNumber: 6,
          title: 'Billing, Operations & ERP',
          topics: [
            'ERP timebox, shifts & billing modules training',
            'Inventory & resource requisition standards',
            'Cross-functional touchpoints walkthrough',
          ],
          mandatorySignOff: false,
        },
        {
          dayNumber: 7,
          title: 'Final Mock Run & Review',
          topics: [
            'Comprehensive mock run / production readiness sign-off',
            '1-on-1 performance & expectation alignment with manager',
            'Orientation milestone completion & buddy feedback',
          ],
          mandatorySignOff: true,
        },
      ],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const OrientationPlan = mongoose.model('OrientationPlan', orientationPlanSchema);
export default OrientationPlan;
