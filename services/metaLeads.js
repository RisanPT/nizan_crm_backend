// Meta Lead Ads → CRM leads: the work (database + Graph API). The rules are in utils/metaLeads.js.
//
//  • receiveLeadgen: a webhook's lead ids are noted (MetaLeadEvent, unique by Meta's lead id — a re-sent webhook adds nothing).
//  • drainMetaLeads: the noted leads are fetched from Meta and made into CRM leads, ONE AT A TIME in this process (so two forms with
//    the same number never make two leads); a failure is kept with its reason and tried again later (5 min, 10, 20… up to 6 tries).
//    Runs after each webhook, every 5 minutes while Meta is configured (startMetaLeadRetries), and when someone opens the screen.
//  • checkMissedLeads: reads every form's leads of the last N days straight from Meta and takes in any the webhook never brought.
// Nothing here ever returns or logs the token.
import Lead from '../models/Lead.js';
import Campaign from '../models/Campaign.js';
import User from '../models/User.js';
import MetaLeadEvent from '../models/MetaLeadEvent.js';
import MetaLeadSettings from '../models/MetaLeadSettings.js';
import { findDuplicateLead } from '../controllers/leadController.js';
import { applyLeadGeography } from './leadGeography.js';
import { applyLeadMarkets } from './leadMarkets.js';
import { notify, getUserIdsByRoles, MANAGER_AND_ADMIN_ROLES, NOTIFICATION_TYPES } from '../utils/notify.js';
import { notifyStylistLeadsOfNewLead } from '../utils/consultationNotify.js';
import { MetaProblem, graphGet } from './metaGraph.js';
import {
  META_LEAD_BY,
  META_LEAD_SOURCE,
  META_MAX_ATTEMPTS,
  answersOf,
  isGraphUrl,
  mapAnswers,
  metaConfig,
  nextTryAt,
  problem,
  remarksFor,
  turnOf,
  usablePhone,
} from '../utils/metaLeads.js';

const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic';
const STUCK_MS = 10 * 60 * 1000;
const trim = (v) => String(v ?? '').trim();
const isGraphId = (v) => /^\d{1,30}$/.test(trim(v));

// A Page's own token (a system-user token can ask for it); some Graph reads (forms, leads) want it. Kept an hour; when it cannot be
// had, the configured token is used as it is (it may itself be a Page token).
const pageTokens = new Map(); // pageId → { token, until }
const formNames = new Map(); // formId → name
export const _resetMetaCaches = () => {
  pageTokens.clear();
  formNames.clear();
};

const tokenForPage = async (cfg, pageId) => {
  if (!isGraphId(pageId)) return cfg.token;
  const hit = pageTokens.get(pageId);
  if (hit && hit.until > Date.now()) return hit.token;
  try {
    const b = await graphGet(cfg, pageId, { fields: 'access_token' }, cfg.token);
    const t = trim(b.access_token) || cfg.token;
    pageTokens.set(pageId, { token: t, until: Date.now() + 60 * 60 * 1000 });
    return t;
  } catch {
    pageTokens.set(pageId, { token: cfg.token, until: Date.now() + 5 * 60 * 1000 });
    return cfg.token;
  }
};

/** A Graph read as the Page; when the Page token is refused, once more with the configured token. */
const graphAsPage = async (cfg, pageId, pathOrUrl, params) => {
  const t = await tokenForPage(cfg, pageId);
  try {
    return await graphGet(cfg, pathOrUrl, params, t);
  } catch (e) {
    const code = e.problem?.code;
    if (t === cfg.token || !['token', 'permission'].includes(code)) throw e;
    // an expired Page token → ask for a fresh one; a Page token without the right → the configured token itself
    pageTokens.delete(pageId);
    const other = code === 'token' ? await tokenForPage(cfg, pageId) : cfg.token;
    if (other === t) throw e;
    try {
      return await graphGet(cfg, pathOrUrl, params, other);
    } catch (e2) {
      throw code === 'token' ? e : e2; // the reason the team must act on is the token that expired
    }
  }
};

const formNameOf = async (cfg, pageId, formId) => {
  if (!isGraphId(formId)) return '';
  if (formNames.has(formId)) return formNames.get(formId);
  try {
    const b = await graphAsPage(cfg, pageId, formId, { fields: 'name' });
    const name = trim(b.name).slice(0, 160);
    formNames.set(formId, name);
    return name;
  } catch {
    return ''; // the lead matters more than its form's name
  }
};

/** Every row of a Graph list, following Graph's next-page links (only on Graph's host) up to [maxPages]. */
const listAll = async (cfg, pageId, path, params, maxPages) => {
  const out = [];
  let body = await graphAsPage(cfg, pageId, path, params);
  for (let i = 1; ; i += 1) {
    if (Array.isArray(body.data)) out.push(...body.data);
    const next = body.paging?.next;
    if (!next || i >= maxPages || !isGraphUrl(next)) return out;
    body = await graphAsPage(cfg, pageId, next, {});
  }
};

// ── settings ────────────────────────────────────────────────────────────────

export const loadMetaSettings = () =>
  MetaLeadSettings.findOneAndUpdate({ key: 'meta' }, { $setOnInsert: { key: 'meta' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

/** The Pages "Check for missed leads" reads: the server's META_PAGE_IDS and every Page that has sent a lead. */
export const knownPageIds = async (cfg = metaConfig()) => {
  const s = await loadMetaSettings();
  return [...new Set([...cfg.pageIds, ...(s.pageIds ?? []).filter(isGraphId)])];
};

/** Whose turn it is for a new Meta lead (settings: take turns among chosen Sales people), or null (it waits for a manager). */
const pickAssignee = async () => {
  const s = await loadMetaSettings();
  if (s.assignMode !== 'rotate' || !s.rotateUserIds?.length) return null;
  const users = await User.find({ _id: { $in: s.rotateUserIds }, active: { $ne: false } }).select('_id name').lean();
  const order = s.rotateUserIds.map(String).filter((id) => users.some((u) => String(u._id) === id));
  if (!order.length) return null;
  const turn = await MetaLeadSettings.findOneAndUpdate({ key: 'meta' }, { $inc: { rotateCounter: 1 } }, { new: true }).lean();
  const id = turnOf(order, turn.rotateCounter);
  return users.find((u) => String(u._id) === id) ?? null;
};

// ── taking leads in ──────────────────────────────────────────────────────────

/** Note the leads of one webhook. → the ids that were new (a re-sent webhook's leads are already noted). */
export const receiveLeadgen = async (changes) => {
  const fresh = [];
  for (const c of changes) {
    try {
      const r = await MetaLeadEvent.updateOne(
        { leadgenId: c.leadgenId },
        {
          $setOnInsert: {
            leadgenId: c.leadgenId,
            pageId: c.pageId,
            formId: c.formId,
            adId: c.adId,
            adsetId: c.adsetId,
            submittedAt: c.createdTime,
            via: 'webhook',
            status: 'received',
          },
        },
        { upsert: true },
      );
      if (r.upsertedCount) fresh.push(c.leadgenId);
    } catch (err) {
      if (err?.code !== 11000) throw err; // the same lead arriving twice at once: already noted
    }
  }
  const pages = [...new Set(changes.map((c) => c.pageId).filter(isGraphId))];
  if (pages.length) await MetaLeadSettings.updateOne({ key: 'meta' }, { $addToSet: { pageIds: { $each: pages } } }, { upsert: true });
  return fresh;
};

// One lead at a time in this process: two forms with the same number must not both pass the duplicate check before either is saved.
let chain = Promise.resolve();
const serial = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

const graphTime = (v) => {
  const s = trim(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'); // 2026-11-18T10:20:30+0000 → …+00:00
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

const finish = async (ev, set, prob = null) => {
  const now = new Date();
  if (prob) {
    const next = nextTryAt(ev.attempts, now, prob.retry);
    await MetaLeadEvent.updateOne(
      { _id: ev._id },
      { $set: { ...set, status: 'failed', problemCode: prob.code, problemText: prob.text, retry: !!next, nextTryAt: next, workingSince: null } },
    );
    return 'failed';
  }
  await MetaLeadEvent.updateOne(
    { _id: ev._id },
    { $set: { ...set, problemCode: '', problemText: '', retry: false, nextTryAt: null, workingSince: null, doneAt: now } },
  );
  return set.status;
};

const quietly = async (what, fn) => {
  try {
    await fn();
  } catch (err) {
    console.error(`[Meta leads] ${what} failed:`, err?.message ?? err);
  }
};

/** Her number is already a CRM lead: say so on that lead (its history) and tell its owner (or the managers). Nothing else changes. */
const noteAgain = async (dupe, info) => {
  const how = [info.formName && `the form "${info.formName}"`, info.adName && `ad "${info.adName}"`, info.campaignName && `campaign "${info.campaignName}"`]
    .filter(Boolean)
    .join(', ');
  await Lead.updateOne(
    { _id: dupe._id },
    { $push: { auditLog: { action: 'meta_form_again', byName: META_LEAD_BY, note: `Filled a Meta Lead Ads form again${how ? ` (${how})` : ''}.`, at: new Date() } } },
  );
  await quietly('repeat-lead notice', async () => {
    const owner = dupe.assignedTo?._id ?? dupe.assignedTo ?? null;
    const recipients = owner ? [owner] : await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
    await notify({
      recipients,
      type: NOTIFICATION_TYPES.NEW_LEAD,
      title: 'Meta lead came again',
      body: `${dupe.name} filled a Meta form again${info.formName ? ` ("${info.formName}")` : ''}. The number is already this lead.`,
      leadId: dupe._id,
    });
  });
};

/** A new CRM lead from the form's answers. A field that fails the CRM's own checks is left out and kept in the remarks instead. */
const makeLead = async (m, info, campaign, assignee, leadgenId) => {
  const notes = [];
  const when = info.submittedAt ?? new Date();
  const data = {
    name: m.name || 'Name not given (Meta form)',
    phone: m.phone,
    source: META_LEAD_SOURCE,
    status: 'New',
    campaignId: campaign?._id ?? null,
    location: m.location,
    eventType: m.eventType,
    probableDate: m.probableDate,
    leadDate: when,
    enquiryDate: when,
    assignedTo: assignee?._id ?? null,
    createdBy: null,
    createdByName: META_LEAD_BY,
  };
  if (m.pincode) {
    const geo = { pincode: m.pincode };
    try {
      await applyLeadGeography(geo);
      Object.assign(data, geo);
    } catch {
      notes.push(`Pincode: ${m.pincode}`);
    }
  }
  const market = [
    ['email', m.email, 'E-mail'],
    ['whatsapp', m.whatsapp && m.whatsapp !== m.phone ? m.whatsapp : '', 'WhatsApp'],
    ['creative', info.adName.slice(0, 120), 'Ad'],
  ];
  for (const [key, value, label] of market) {
    if (!value) continue;
    const one = { [key]: value };
    try {
      await applyLeadMarkets(one);
      Object.assign(data, one);
    } catch {
      if (key !== 'creative') notes.push(`${label}: ${value}`); // the ad's name is already in the first line of the remarks
    }
  }
  data.remarks = remarksFor({ ...info, extra: m.extra, notes });
  data.auditLog = [{ action: 'meta_lead', byName: META_LEAD_BY, note: `Made from Meta lead ${leadgenId}.`, at: new Date() }];
  data.origin = 'meta_lead_ads';
  return Lead.create(data);
};

const tellAboutNewLead = async (lead, info, assignee) => {
  const from = info.formName ? ` (form "${info.formName}")` : '';
  await quietly('new-lead notice', async () => {
    const managers = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
    await notify({
      recipients: managers,
      type: NOTIFICATION_TYPES.NEW_LEAD,
      title: 'New Meta lead',
      body: `${lead.name} came in from Meta Lead Ads${from}${assignee ? `, given to ${assignee.name}` : ', waiting to be assigned'}.`,
      leadId: lead._id,
      excludeUserId: assignee?._id ?? null,
    });
    if (assignee) {
      await notify({
        recipients: [assignee._id],
        type: NOTIFICATION_TYPES.NEW_LEAD,
        title: 'New Meta lead for you',
        body: `${lead.name} filled a Meta form${from}. Call her soon — a fresh lead answers best.`,
        leadId: lead._id,
      });
    }
  });
  await quietly('stylist notice', () => notifyStylistLeadsOfNewLead(lead, null));
};

/** One noted lead (already claimed: status 'working', attempts counted) → created | existing | failed. [prefetched] = Meta's lead. */
const processEvent = async (cfg, ev, prefetched = null) => {
  try {
    const g = prefetched ?? (await graphAsPage(cfg, ev.pageId, ev.leadgenId, { fields: LEAD_FIELDS }));
    const formId = isGraphId(g.form_id) ? trim(g.form_id) : ev.formId;
    const info = {
      formName: formId ? await formNameOf(cfg, ev.pageId, formId) : '',
      adName: trim(g.ad_name).slice(0, 200),
      campaignName: trim(g.campaign_name).slice(0, 200),
      platform: ['fb', 'ig'].includes(trim(g.platform)) ? trim(g.platform) : '',
      isOrganic: g.is_organic === true,
      submittedAt: graphTime(g.created_time) ?? ev.submittedAt ?? null,
    };
    const m = mapAnswers(answersOf(g.field_data));
    const set = {
      formId,
      adId: isGraphId(g.ad_id) ? trim(g.ad_id) : ev.adId,
      adsetId: isGraphId(g.adset_id) ? trim(g.adset_id) : ev.adsetId,
      metaCampaignId: isGraphId(g.campaign_id) ? trim(g.campaign_id) : '',
      leadName: m.name.slice(0, 120),
      ...info,
    };
    if (!usablePhone(m.phone)) return finish(ev, { ...set, email: m.email.slice(0, 120) }, problem('no_phone'));

    const campaign = set.metaCampaignId ? await Campaign.findOne({ metaCampaignId: set.metaCampaignId }).select('_id name').lean() : null;
    set.campaignId = campaign?._id ?? null;
    const dupe = await findDuplicateLead([m.phone, m.whatsapp]);
    if (dupe) {
      await noteAgain(dupe, info);
      return finish(ev, { ...set, status: 'existing', leadId: dupe._id, leadName: dupe.name || set.leadName });
    }
    const assignee = await pickAssignee();
    const lead = await makeLead(m, info, campaign, assignee, ev.leadgenId);
    const status = await finish(ev, { ...set, status: 'created', leadId: lead._id, assignedTo: assignee?._id ?? null, assignedToName: assignee?.name ?? '' });
    await tellAboutNewLead(lead, info, assignee);
    return status;
  } catch (err) {
    const p = err instanceof MetaProblem ? err.problem : problem('save_failed', trim(err?.message).slice(0, 160));
    if (!(err instanceof MetaProblem)) console.error('[Meta leads] saving a lead failed:', err?.message ?? err);
    return finish(ev, {}, p);
  }
};

let draining = null;
let drainAgain = false;

/** Take in every noted lead that is waiting (and every failed one that is due again). One run at a time; a call during a run adds a pass. */
export const drainMetaLeads = () => {
  if (draining) {
    drainAgain = true;
    return draining;
  }
  draining = (async () => {
    try {
      do {
        drainAgain = false;
        await drainOnce();
      } while (drainAgain);
    } finally {
      draining = null;
    }
  })();
  return draining;
};

const drainOnce = async () => {
  const cfg = metaConfig();
  if (!cfg.ready) return;
  for (let i = 0; i < 500; i += 1) {
    const now = new Date();
    const ev = await MetaLeadEvent.findOneAndUpdate(
      {
        $or: [
          { status: 'received' },
          { status: 'failed', retry: true, nextTryAt: { $ne: null, $lte: now } },
          { status: 'working', workingSince: { $lt: new Date(now.getTime() - STUCK_MS) } },
        ],
      },
      { $set: { status: 'working', workingSince: now }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1, _id: 1 }, new: true },
    ).lean();
    if (!ev) return;
    await serial(() => processEvent(cfg, ev));
  }
};

/** Try one failed lead again now (the team's Retry button). → false when it is not a failed lead. */
export const retryMetaLead = async (id) => {
  const r = await MetaLeadEvent.updateOne({ _id: id, status: 'failed' }, { $set: { status: 'received', nextTryAt: null } });
  if (!r.modifiedCount) return false;
  await drainMetaLeads();
  return true;
};

// ── "Check for missed leads" ─────────────────────────────────────────────────

let checking = false;

/** Read every form's leads of the last [days] from Meta and take in those never noted. One check at a time. */
export const checkMissedLeads = async ({ days, byName = '' }) => {
  const cfg = metaConfig();
  if (!cfg.ready) throw new MetaProblem(problem('not_configured'));
  if (checking) return { busy: true };
  checking = true;
  const result = { days, pages: 0, forms: 0, found: 0, added: 0, already: 0, failed: 0, problem: '' };
  try {
    const pages = await knownPageIds(cfg);
    result.pages = pages.length;
    if (!pages.length) result.problem = 'No Facebook Page is known yet. It is learnt from the first lead Meta sends, or set META_PAGE_IDS on the server.';
    const since = Math.floor((Date.now() - days * 864e5) / 1000);
    for (const pageId of pages) {
      let forms;
      try {
        forms = await listAll(cfg, pageId, `${pageId}/leadgen_forms`, { fields: 'id,name', limit: 100 }, 10);
      } catch (e) {
        result.problem = e.problem?.text ?? 'Meta refused the request.';
        continue;
      }
      for (const f of forms) {
        if (!isGraphId(f?.id)) continue;
        result.forms += 1;
        if (trim(f.name)) formNames.set(trim(f.id), trim(f.name).slice(0, 160));
        let leads;
        try {
          leads = await listAll(
            cfg,
            pageId,
            `${trim(f.id)}/leads`,
            { fields: LEAD_FIELDS, limit: 100, filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]) },
            20,
          );
        } catch (e) {
          result.problem = e.problem?.text ?? 'Meta refused the request.';
          continue;
        }
        for (const g of leads) {
          const leadgenId = trim(g?.id);
          if (!isGraphId(leadgenId)) continue;
          result.found += 1;
          let inserted = false;
          try {
            const r = await MetaLeadEvent.updateOne(
              { leadgenId },
              {
                $setOnInsert: {
                  leadgenId,
                  pageId,
                  formId: trim(f.id),
                  via: 'check',
                  status: 'working',
                  workingSince: new Date(),
                  attempts: 1,
                  submittedAt: graphTime(g.created_time),
                },
              },
              { upsert: true },
            );
            inserted = r.upsertedCount > 0;
          } catch (err) {
            if (err?.code !== 11000) throw err;
          }
          if (!inserted) {
            result.already += 1;
            continue;
          }
          const ev = await MetaLeadEvent.findOne({ leadgenId }).lean();
          const status = await serial(() => processEvent(cfg, ev, g));
          if (status === 'failed') result.failed += 1;
          else result.added += 1;
        }
      }
    }
    return result;
  } finally {
    checking = false;
    await MetaLeadSettings.updateOne(
      { key: 'meta' },
      { $set: { lastCheck: { at: new Date(), byName, days, forms: result.forms, found: result.found, added: result.added, already: result.already, failed: result.failed, problem: result.problem } } },
      { upsert: true },
    ).catch(() => {});
  }
};

// ── "Test connection" ────────────────────────────────────────────────────────

/** Who the token is, and whether each known Page can be read with it. Never returns the token. */
export const testMetaConnection = async () => {
  const cfg = metaConfig();
  if (!cfg.ready) return { ok: false, problem: problem('not_configured') };
  try {
    const me = await graphGet(cfg, 'me', { fields: 'id,name' }, cfg.token);
    const pages = [];
    for (const id of (await knownPageIds(cfg)).slice(0, 10)) {
      try {
        const p = await graphAsPage(cfg, id, id, { fields: 'id,name' });
        pages.push({ id, name: trim(p.name), ok: true, problem: '' });
      } catch (e) {
        pages.push({ id, name: '', ok: false, problem: e.problem?.text ?? 'Meta refused the request.' });
      }
    }
    return { ok: true, name: trim(me.name), id: trim(me.id), pages };
  } catch (e) {
    return { ok: false, problem: e.problem ?? problem('refused') };
  }
};

// ── background retries ───────────────────────────────────────────────────────

let retryTimer = null;
/** Called once at server start: when Meta is configured, take in waiting leads now and every 5 minutes. */
export const startMetaLeadRetries = () => {
  if (retryTimer || !metaConfig().ready) return;
  drainMetaLeads().catch((err) => console.error('[Meta leads] retry failed:', err?.message ?? err));
  retryTimer = setInterval(() => {
    drainMetaLeads().catch((err) => console.error('[Meta leads] retry failed:', err?.message ?? err));
  }, 5 * 60 * 1000);
  retryTimer.unref?.();
};

export { META_MAX_ATTEMPTS, MetaProblem };
export { _setMetaFetch } from './metaGraph.js';
