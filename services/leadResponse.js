// Speed to lead — the database side (the rules: utils/leadResponse.js).
//  • stampFirstContact: the first contact is stamped once on the lead (the first activity logged, or the first move out of New).
//  • firstActivities: each lead's first logged LeadActivity (who, when, how) — older leads' first contact comes from these.
//  • checkWaitingLeads: a lead that came in on its own and still waits after the alert time tells its salesperson and the sales
//    managers — once (Lead.responseAlertAt is claimed atomically). Run every 5 minutes (startLeadResponseWatch) and when the Speed to
//    lead tab is read, so it works even where the timer does not run.
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import LeadResponseSettings from '../models/LeadResponseSettings.js';
import { DEFAULT_RESPONSE_SETTINGS, META_LEAD_BY, AUTO_ORIGINS, shouldAlert, businessMinutes } from '../utils/leadResponse.js';
import { notify, getUserIdsByRoles, MANAGER_ROLES, NOTIFICATION_TYPES } from '../utils/notify.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

export const loadResponseSettings = async () => {
  const s = await LeadResponseSettings.findOne({ key: 'main' }).lean();
  return s ? { targetMinutes: s.targetMinutes, alertAfterMinutes: s.alertAfterMinutes, dayStart: s.dayStart, dayEnd: s.dayEnd, alertsOn: s.alertsOn !== false, updatedByName: s.updatedByName ?? '', updatedAt: s.updatedAt ?? null } : { ...DEFAULT_RESPONSE_SETTINGS, updatedByName: '', updatedAt: null };
};

export const saveResponseSettings = async (value, byName = '') =>
  LeadResponseSettings.findOneAndUpdate({ key: 'main' }, { $set: { ...value, updatedByName: byName } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

/** The lead's first contact, stamped once (a later contact never moves it). `via` = call, whatsapp, follow-up, status… */
export const stampFirstContact = async (leadId, { at = new Date(), user = null, via = '' } = {}) => {
  if (!mongoose.isValidObjectId(String(leadId))) return false;
  const r = await Lead.updateOne({ _id: leadId, firstContactAt: null }, { $set: { firstContactAt: at, firstContactBy: user?._id ?? null, firstContactByName: user?.name ?? '', firstContactVia: via } });
  return r.modifiedCount === 1;
};

/** Map(leadId → { at, byName, via }) of each lead's first logged activity. */
export const firstActivities = async (leadIds) => {
  const ids = leadIds.filter((id) => mongoose.isValidObjectId(String(id))).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return new Map();
  const rows = await LeadActivity.aggregate([
    { $match: { leadId: { $in: ids } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: '$leadId', at: { $first: '$createdAt' }, by: { $first: '$createdBy' }, type: { $first: '$type' }, channel: { $first: '$channel' } } },
  ]);
  const User = mongoose.model('User');
  const users = await User.find({ _id: { $in: [...new Set(rows.map((r) => idOf(r.by)).filter(Boolean))] } }).select('name').lean();
  const names = new Map(users.map((u) => [idOf(u), u.name ?? '']));
  return new Map(rows.map((r) => [idOf(r._id), { at: r.at, byName: names.get(idOf(r.by)) ?? '', via: r.channel || r.type || '' }]));
};

const AUTO_MATCH = { $or: [{ origin: { $in: AUTO_ORIGINS } }, { createdByName: META_LEAD_BY }] };

let lastCheck = 0;
/**
 * Tell the salesperson (and the sales managers) about each lead that came in on its own and has waited past the alert time with no
 * contact — once per lead. [throttleMs] skips a check run moments ago (a screen read). Returns how many alerts went out.
 */
export const checkWaitingLeads = async ({ now = new Date(), throttleMs = 0 } = {}) => {
  if (throttleMs && Date.now() - lastCheck < throttleMs) return 0;
  lastCheck = Date.now();
  const settings = await loadResponseSettings();
  if (!settings.alertsOn) return 0;
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const leads = await Lead.find({ status: 'New', firstContactAt: null, responseAlertAt: null, createdAt: { $gte: since }, ...AUTO_MATCH })
    .select('name source status origin createdByName createdAt assignedTo firstContactAt responseAlertAt')
    .sort({ createdAt: 1 })
    .limit(300)
    .lean();
  if (!leads.length) return 0;
  const firsts = await firstActivities(leads.map((l) => l._id));
  let managers = null;
  let sent = 0;
  for (const lead of leads) {
    const first = firsts.get(idOf(lead));
    if (first) {
      // contacted, but before the stamp existed: stamp it now (the screens read the same either way)
      await Lead.updateOne({ _id: lead._id, firstContactAt: null }, { $set: { firstContactAt: first.at, firstContactByName: first.byName, firstContactVia: first.via } });
      continue;
    }
    if (!shouldAlert(lead, null, now, settings)) continue;
    // claimed once: two checks at the same moment never both send
    const claimed = await Lead.updateOne({ _id: lead._id, responseAlertAt: null }, { $set: { responseAlertAt: now } });
    if (claimed.modifiedCount !== 1) continue;
    managers ??= await getUserIdsByRoles(MANAGER_ROLES);
    const waited = businessMinutes(lead.createdAt, now, settings);
    await notify({
      recipients: [...(lead.assignedTo ? [lead.assignedTo] : []), ...managers],
      type: NOTIFICATION_TYPES.LEAD_WAITING,
      title: 'A new lead is waiting',
      body: `${lead.name} (${lead.source || 'a form'}) came in ${waited} working minutes ago and has not been contacted yet.${lead.assignedTo ? '' : ' Nobody is assigned.'}`,
      leadId: lead._id,
    });
    sent += 1;
  }
  return sent;
};

let timer = null;
/** Every 5 minutes, check for leads left waiting (the first check a minute after start). */
export const startLeadResponseWatch = () => {
  if (timer) return;
  const run = () => checkWaitingLeads().catch((e) => console.error('[lead-response] check failed:', e.message));
  setTimeout(run, 60 * 1000).unref?.();
  timer = setInterval(run, 5 * 60 * 1000);
  timer.unref?.();
};
