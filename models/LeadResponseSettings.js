import mongoose from 'mongoose';

// Speed to lead: the target time to a first contact, when the "a new lead is waiting" alert goes out, and the daily working hours
// (IST) the waiting is counted in. One record (key 'main'); defaults in utils/leadResponse.js. Changed by a sales or marketing manager.
const leadResponseSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'main', unique: true },
    targetMinutes: { type: Number, default: 15, min: 1, max: 1440 },
    alertAfterMinutes: { type: Number, default: 30, min: 1, max: 2880 },
    dayStart: { type: String, default: '09:00' },
    dayEnd: { type: String, default: '21:00' },
    alertsOn: { type: Boolean, default: true },
    updatedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

export default mongoose.model('LeadResponseSettings', leadResponseSettingsSchema);
