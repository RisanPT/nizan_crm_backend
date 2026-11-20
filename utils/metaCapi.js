// Meta Conversions API for CRM: the pure rules (no database, no network). services/metaCapi.js does the work.
//
// What it is for: Meta learns which Lead Ads leads turn into bookings, so it shows the ads to people like those who BOOK, not only to
// people who fill forms. For every lead that came from a Lead Ads form, each CRM stage it reaches is sent once as an event:
//   Lead (the form arrived) → Contacted → Qualified → Converted (a booking was saved); Follow-up and Lost are sent as they happen.
// Meta's rules (Conversions API → Conversion Leads integration, payload specification):
//   • POST /{dataset id}/events, body { data: [events] }, at most 1,000 events a request — and one bad event drops the whole request;
//   • action_source "system_generated"; custom_data { event_source: "crm", lead_event_source: <the CRM's name> };
//   • user_data.lead_id = Meta's lead id (15–17 digits, NOT hashed); e-mail and phone may be added, hashed (SHA-256 of the normalised value);
//   • event_time in Unix seconds, after the lead was generated and at most 7 days old;
//   • a lead that reaches the last stage should have had every earlier stage sent — so reaching Converted also sends a Contacted and
//     Qualified that were never sent (the CRM keeps no history of when a lead passed them; they take the time of the stage reached).
//
// Settings from the server's environment:
//   META_CAPI_DATASET_ID  the dataset (CRM pixel) id from Events Manager
//   META_CAPI_TOKEN       optional: the Conversions API token Events Manager generates; without it META_ACCESS_TOKEN is used (it then
//                         needs access to the dataset)
//   META_CAPI_TEST_CODE   optional: Events Manager's "Test events" code — events then show there and count for nothing
// Nothing is sent until the Marketing Manager / admin switches it on in the app.
import crypto from 'node:crypto';
import { metaConfig } from './metaLeads.js';

export const CAPI_LEAD_EVENT_SOURCE = 'Team N CRM';
export const CAPI_MAX_AGE_DAYS = 7;
export const CAPI_BATCH = 50; // a first send goes in requests of 50 (one bad event drops its request); a retry goes alone
export const CAPI_MAX_ATTEMPTS = 6;
export const CAPI_WINDOW_DAYS = 35; // a Meta lead is followed this long (Meta optimises for stages reached within 28 days)
export const CAPI_EVERY_MINUTES = 60;

const trim = (v) => String(v ?? '').trim();

/** What the environment provides. Never hands out the token itself. */
export const capiConfig = (env = process.env) => {
  const c = metaConfig(env);
  const datasetId = trim(env.META_CAPI_DATASET_ID);
  const ownToken = trim(env.META_CAPI_TOKEN);
  const testCode = trim(env.META_CAPI_TEST_CODE).slice(0, 64);
  const token = ownToken || c.token;
  const validDataset = /^\d{1,30}$/.test(datasetId);
  return {
    datasetId: validDataset ? datasetId : '',
    token,
    // a token made by Events Manager belongs to Meta's own app: our app secret's proof would not match it
    proof: !ownToken,
    appSecret: c.appSecret,
    version: c.version,
    testCode,
    has: { dataset: validDataset, token: !!token, ownToken: !!ownToken, testMode: !!testCode },
    ready: !!(validDataset && token && (ownToken || c.appSecret)),
  };
};

export const CAPI_NOT_CONFIGURED = {
  code: 'not_configured',
  retry: false,
  text: 'Sending results to Meta is not set up on the server (META_CAPI_DATASET_ID, and META_CAPI_TOKEN or META_ACCESS_TOKEN with META_APP_SECRET).',
};

// ── stages ──────────────────────────────────────────────────────────────────

/** The stages Meta gets, in funnel order. */
export const CAPI_STAGES = ['Lead', 'Contacted', 'Qualified', 'Follow-up', 'Converted', 'Lost'];

/**
 * The stages a lead with this CRM status has reached — the ones that should have been sent. A Converted lead (or one with a booking)
 * has passed Contacted and Qualified; a Follow-up lead was contacted. Pending Lost Approval sends nothing new (a manager has not
 * decided yet). An unknown status is just a Lead.
 */
export const stagesFor = (status, { booked = false } = {}) => {
  const s = trim(status).toLowerCase();
  if (booked || s === 'converted') return ['Lead', 'Contacted', 'Qualified', 'Converted'];
  if (s === 'contacted') return ['Lead', 'Contacted'];
  if (s === 'qualified') return ['Lead', 'Contacted', 'Qualified'];
  if (s === 'follow-up' || s === 'follow up' || s === 'followup') return ['Lead', 'Contacted', 'Follow-up'];
  if (s === 'lost') return ['Lead', 'Lost'];
  return ['Lead'];
};

/**
 * When each stage happened, in Unix seconds: the form's time for Lead; the booking's time for Converted; the lead's last change for
 * the rest — never before the form arrived, never in the future.
 */
export const stageTime = (stage, { submittedAt, bookedAt, updatedAt }, now = new Date()) => {
  const at = (d) => (d ? new Date(d).getTime() : NaN);
  const start = Number.isFinite(at(submittedAt)) ? at(submittedAt) : now.getTime();
  let t = stage === 'Lead' ? start : stage === 'Converted' && Number.isFinite(at(bookedAt)) ? at(bookedAt) : at(updatedAt);
  if (!Number.isFinite(t)) t = now.getTime();
  if (stage !== 'Lead' && t <= start) t = start + 1000;
  return Math.floor(Math.min(t, now.getTime()) / 1000);
};

/**
 * The times of the stages a lead reached, in funnel order, so no stage is dated after a later one: a stage the CRM infers (Contacted and
 * Qualified for a booked lead) takes the time of the stage after it when its own would be later.
 */
export const stageTimes = (stages, times, now = new Date()) => {
  const out = stages.map((s) => stageTime(s, times, now));
  for (let i = out.length - 2; i >= 0; i -= 1) out[i] = Math.min(out[i], out[i + 1]);
  return out;
};

/** Meta takes an event at most 7 days old (with an hour to spare for the send itself). */
export const tooOld = (eventTime, now = new Date()) => eventTime * 1000 < now.getTime() - CAPI_MAX_AGE_DAYS * 864e5 + 3600 * 1000;

// ── customer details, normalised and hashed as Meta asks ────────────────────

export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** An e-mail as Meta matches it: trimmed, lower case. '' when it is not an e-mail. */
export const normEmail = (v) => {
  const s = trim(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};

/**
 * A phone as Meta matches it: digits only, with the country code, no leading zeros. An Indian number typed without its code
 * (98470 12345, 098470 12345) gets 91. '' when too short to be a phone.
 */
export const normPhone = (v) => {
  let d = trim(v).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = `91${d}`;
  d = d.replace(/^0+/, '');
  return d.length >= 10 && d.length <= 15 ? d : '';
};

/** One event as Meta wants it. lead_id stays a string here; requestBody() writes it as a number without losing digits. */
export const capiEvent = ({ stage, eventTime, leadgenId, email, phone }) => {
  const userData = { lead_id: String(leadgenId) };
  const em = normEmail(email);
  const ph = normPhone(phone);
  if (em) userData.em = [sha256(em)];
  if (ph) userData.ph = [sha256(ph)];
  return {
    event_name: stage,
    event_time: eventTime,
    action_source: 'system_generated',
    user_data: userData,
    custom_data: { event_source: 'crm', lead_event_source: CAPI_LEAD_EVENT_SOURCE },
  };
};

/**
 * The JSON body of one request. Meta's lead ids run to 17 digits — more than a JavaScript number holds exactly — so each lead_id is
 * written into the JSON as a number literal from its string, digit for digit.
 */
export const requestBody = (events, testCode = '') => {
  const body = { data: events, ...(testCode ? { test_event_code: testCode } : {}) };
  return JSON.stringify(body).replace(/"lead_id":"(\d{1,20})"/g, '"lead_id":$1');
};

/** The next try of a failed send: 10 min, 20, 40… capped at 6 hours; null when it should not be tried again. */
export const capiNextTry = (attempts, now = new Date(), retry = true) => {
  if (!retry || attempts >= CAPI_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + Math.min(10 * 2 ** Math.max(0, attempts - 1), 360) * 60 * 1000);
};
