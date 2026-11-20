import CrmSettings from '../models/CrmSettings.js';

// The CRM team's rules (models/CrmSettings.js) — made the first time anything asks, so `trackingSince` is the day the CRM records
// started.
export const getCrmSettings = async () => {
  const s = await CrmSettings.findOneAndUpdate(
    { singleton: 'crm' },
    { $setOnInsert: { singleton: 'crm', trackingSince: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return s;
};

/// The day the booking-care records (verified / photos ticks, medical notes) began: set the first time anything asks, kept after.
export const careSince = async (now = new Date()) => {
  const s = await getCrmSettings();
  if (s.careSince) return s.careSince;
  const u = await CrmSettings.findOneAndUpdate({ singleton: 'crm', careSince: null }, { $set: { careSince: now } }, { new: true }).lean();
  return u?.careSince ?? (await getCrmSettings()).careSince ?? now;
};
