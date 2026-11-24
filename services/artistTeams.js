import mongoose from 'mongoose';
import ArtistTeam from '../models/ArtistTeam.js';
import District from '../models/District.js';
import Employee from '../models/Employee.js';

// The in-house artist teams (models/ArtistTeam.js) — set up on the CRM's Artist Management screen: the main artist, her assistants,
// her preferred places, the rotation order and her slots. The allocation reads them (services/artistAllocation.js).

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const EMP_FIELDS = 'name phone status artistRole isAssociate type specialization works districtId';
const MAX_ASSISTANTS = 6;

/** In-house and active, an artist or an assistant — who can be on a team. */
const isInHouse = (e) => e && e.status === 'active' && !e.isAssociate && e.type !== 'outsource';

let cache = null; // { at, teams }
export const _resetTeamCache = () => {
  cache = null;
};

/** The teams with their people and places (active ones first, in rotation order). Cached a minute for the allocation's hot paths. */
export const loadTeams = async ({ includeInactive = false, fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return includeInactive ? cache.teams : cache.teams.filter((t) => t.active);
  const rows = await ArtistTeam.find({}).sort({ active: -1, rotationOrder: 1, createdAt: 1 }).lean();
  const empIds = [...new Set(rows.flatMap((t) => [idOf(t.leadEmployeeId), ...(t.assistantEmployeeIds ?? []).map(idOf)]))];
  const distIds = [...new Set(rows.flatMap((t) => (t.preferredDistrictIds ?? []).map(idOf)))];
  const [emps, dists] = await Promise.all([
    empIds.length ? Employee.find({ _id: { $in: empIds } }).select(EMP_FIELDS).lean() : [],
    distIds.length ? District.find({ _id: { $in: distIds } }).select('name region').lean() : [],
  ]);
  const empBy = new Map(emps.map((e) => [idOf(e), e]));
  const distBy = new Map(dists.map((d) => [idOf(d), d]));
  const person = (id) => {
    const e = empBy.get(idOf(id));
    return e ? { _id: idOf(e), id: idOf(e), name: e.name ?? '', phone: e.phone ?? '', status: e.status ?? 'active', artistRole: e.artistRole ?? '', isAssociate: !!e.isAssociate, type: e.type ?? '', specialization: e.specialization ?? '', works: e.works ?? [], districtId: idOf(e.districtId) } : { _id: idOf(id), id: idOf(id), name: '(removed)', status: 'inactive' };
  };
  const teams = rows.map((t) => {
    const lead = person(t.leadEmployeeId);
    return {
      id: idOf(t),
      name: t.name || `Team ${lead.name}`,
      rotationOrder: t.rotationOrder ?? 0,
      active: t.active !== false,
      leadEmployeeId: idOf(t.leadEmployeeId),
      lead,
      assistants: (t.assistantEmployeeIds ?? []).map(person),
      slots: { morning: t.slots?.morning ?? 2, evening: t.slots?.evening ?? 1 },
      extraAllowed: t.extraAllowed !== false,
      preferredDistrictIds: (t.preferredDistrictIds ?? []).map(idOf),
      preferredDistricts: (t.preferredDistrictIds ?? []).map((d) => ({ id: idOf(d), name: distBy.get(idOf(d))?.name ?? '' })),
      preferredPincodes: t.preferredPincodes ?? [],
      notes: t.notes ?? '',
      updatedByName: t.updatedByName ?? '',
      updatedAt: t.updatedAt ?? null,
    };
  });
  cache = { at: Date.now(), teams };
  return includeInactive ? teams : teams.filter((t) => t.active);
};

const fail = (message, status = 400) => ({ ok: false, message, status });

/**
 * A team as sent → { ok, value } (ready to save) or { ok: false, message, status }. [current] — the team being edited (null for new).
 */
export const cleanTeamInput = async (b = {}, current = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  const leadId = has('leadEmployeeId') ? String(b.leadEmployeeId ?? '') : idOf(current?.leadEmployeeId);
  if (!current || has('leadEmployeeId')) {
    if (!mongoose.isValidObjectId(leadId)) return fail('Choose the main artist.');
    const lead = await Employee.findById(leadId).select(EMP_FIELDS).lean();
    if (!lead) return fail('That artist was not found.', 404);
    if (!isInHouse(lead) || lead.artistRole !== 'artist') return fail(`${lead.name} can't be a main artist: only an active in-house artist (not an assistant, associate or outsource artist) can lead a team.`);
    out.leadEmployeeId = leadId;
    if (!current && !has('name')) out.name = `Team ${lead.name}`;
  }
  // another ACTIVE team led by her?
  const willBeActive = has('active') ? b.active !== false : current ? current.active !== false : true;
  if (willBeActive && (out.leadEmployeeId || has('active'))) {
    const other = await ArtistTeam.findOne({ leadEmployeeId: leadId, active: true, ...(current ? { _id: { $ne: current._id } } : {}) }).select('name').lean();
    if (other) return fail(`She already leads ${other.name || 'another team'}.`, 409);
  }
  if (has('assistantEmployeeIds')) {
    const ids = [...new Set((Array.isArray(b.assistantEmployeeIds) ? b.assistantEmployeeIds : []).map(String))].filter((x) => x !== leadId);
    if (ids.length > MAX_ASSISTANTS) return fail(`A team has at most ${MAX_ASSISTANTS} assistants.`);
    if (ids.some((x) => !mongoose.isValidObjectId(x))) return fail('One of the assistants was not found.');
    const emps = ids.length ? await Employee.find({ _id: { $in: ids } }).select(EMP_FIELDS).lean() : [];
    const by = new Map(emps.map((e) => [idOf(e), e]));
    for (const x of ids) {
      const e = by.get(x);
      if (!e) return fail('One of the assistants was not found.', 404);
      if (!isInHouse(e) || !['artist', 'assistant'].includes(e.artistRole)) return fail(`${e.name} can't be on a team: only active in-house artists and assistants can.`);
    }
    // a main artist of another team is hers to lead, not someone else's assistant
    const leads = ids.length ? await ArtistTeam.find({ leadEmployeeId: { $in: ids }, active: true, ...(current ? { _id: { $ne: current._id } } : {}) }).select('name leadEmployeeId').lean() : [];
    if (leads.length) return fail(`${by.get(idOf(leads[0].leadEmployeeId))?.name ?? 'She'} leads ${leads[0].name || 'a team'} — she can't be an assistant here.`);
    out.assistantEmployeeIds = ids;
  }
  if (has('name')) out.name = String(b.name ?? '').trim().slice(0, 80);
  if (has('slots')) {
    const s = b.slots ?? {};
    const m = Number(s.morning ?? current?.slots?.morning ?? 2);
    const e = Number(s.evening ?? current?.slots?.evening ?? 1);
    if (![m, e].every((n) => Number.isInteger(n) && n >= 0 && n <= 4)) return fail('Slots are whole numbers from 0 to 4.');
    out.slots = { morning: m, evening: e };
  }
  if (has('extraAllowed')) out.extraAllowed = b.extraAllowed !== false;
  if (has('active')) out.active = b.active !== false;
  if (has('preferredDistrictIds')) {
    const ids = [...new Set((Array.isArray(b.preferredDistrictIds) ? b.preferredDistrictIds : []).map(String))];
    if (ids.length > 60 || ids.some((x) => !mongoose.isValidObjectId(x))) return fail('Choose the preferred districts from the list.');
    const found = ids.length ? await District.countDocuments({ _id: { $in: ids } }) : 0;
    if (found !== ids.length) return fail('One of the districts was not found.', 404);
    out.preferredDistrictIds = ids;
  }
  if (has('preferredPincodes')) {
    const pins = [...new Set((Array.isArray(b.preferredPincodes) ? b.preferredPincodes : []).map((p) => String(p ?? '').replace(/\D/g, '')).filter(Boolean))];
    if (pins.length > 40) return fail('Keep the preferred areas to 40 pincodes.');
    if (pins.some((p) => !/^[1-9]\d{5}$/.test(p))) return fail('A pincode is 6 digits, like 673001.');
    out.preferredPincodes = pins;
  }
  if (has('notes')) out.notes = String(b.notes ?? '').trim().slice(0, 500);
  return { ok: true, value: out };
};

/** Who can be on a team: active in-house artists and assistants, and which team each already leads or helps. */
export const teamCandidates = async () => {
  const [emps, teams] = await Promise.all([
    Employee.find({ status: 'active', isAssociate: { $ne: true }, type: { $ne: 'outsource' }, artistRole: { $in: ['artist', 'assistant'] } }).select('name phone artistRole specialization districtId').sort({ name: 1 }).lean(),
    ArtistTeam.find({ active: true }).select('name leadEmployeeId assistantEmployeeIds').lean(),
  ]);
  const leads = new Map(teams.map((t) => [idOf(t.leadEmployeeId), { id: idOf(t), name: t.name }]));
  const helps = new Map();
  for (const t of teams) for (const a of t.assistantEmployeeIds ?? []) helps.set(idOf(a), [...(helps.get(idOf(a)) ?? []), t.name]);
  return emps.map((e) => ({ id: idOf(e), name: e.name, phone: e.phone ?? '', artistRole: e.artistRole, specialization: e.specialization ?? '', leadsTeam: leads.get(idOf(e)) ?? null, assistsTeams: helps.get(idOf(e)) ?? [] }));
};

/** Warnings about a team (not refusals): an assistant who is also on another team. */
export const teamWarnings = (team, all) => {
  const out = [];
  for (const a of team.assistants ?? []) {
    const also = all.filter((t) => t.id !== team.id && t.active && t.assistants.some((x) => x.id === a.id)).map((t) => t.name);
    if (also.length) out.push(`${a.name} is also on ${also.join(', ')}`);
  }
  return out;
};
