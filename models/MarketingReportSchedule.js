import mongoose from 'mongoose';

// A SCHEDULED marketing report (utils/marketingReportSchedule.js has the rules): which report, how often, at what time (IST), switched
// on or off by a marketing manager, and the period it last ran for (so it runs once per period).
const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // e.g. 'team.weekly'
    module: { type: String, enum: ['team', 'campaigns', 'leads'], required: true },
    kind: { type: String, required: true }, // the module's report type
    label: { type: String, required: true },
    cadence: { type: String, enum: ['weekly', 'monthly', 'quarterly'], required: true },
    weekday: { type: Number, min: 0, max: 6, default: 1 },
    dayOfMonth: { type: Number, min: 1, max: 28, default: 1 },
    time: { type: String, default: '10:00' }, // HH:mm IST
    enabled: { type: Boolean, default: false },
    lastPeriodKey: { type: String, default: '' },
    lastRunAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

const MarketingReportSchedule = mongoose.model('MarketingReportSchedule', schema);
export default MarketingReportSchedule;
