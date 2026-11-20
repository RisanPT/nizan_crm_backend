// The CRM dashboard's "Recent activities" and "Upcoming trials", shaped without the database (pure — tests/crmFeed.test.js). The
// records are read by services/crmFeed.js. Names only — no phone numbers: the dashboard is read by leadership too.

import { requestArrivedAt } from './crmBookingAudit.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const nameOr = (s, fallback) => String(s ?? '').trim() || fallback;

export const CASE_STATUS_LABELS = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed' };
const DECISION_WORDS = { confirmed: 'confirmed', approved: 'confirmed', rejected: 'declined', cancelled: 'declined', declined: 'declined' };

/** What happened to a booking request, as one line each: it came in; it was decided. */
export const requestEvents = (bookings, since) => {
  const out = [];
  for (const b of bookings) {
    const who = nameOr(b.customerName, 'a client');
    // when it ARRIVED (the first status the server recorded) — a booking's createdAt can be back-dated
    const arrived = requestArrivedAt(b);
    if (arrived && new Date(arrived) >= since) out.push({ kind: 'request', at: arrived, text: `New booking request from ${who}`, refType: 'booking', refId: idOf(b) });
    if (b.requestDecidedAt && new Date(b.requestDecidedAt) >= since) {
      const word = DECISION_WORDS[String(b.requestDecision ?? '').toLowerCase()] ?? `moved to ${b.requestDecision}`;
      out.push({ kind: 'decided', at: b.requestDecidedAt, text: `Request from ${who} ${word}${b.requestDecidedByName ? ` by ${b.requestDecidedByName}` : ''}`, refType: 'booking', refId: idOf(b) });
    }
  }
  return out;
};

/** The latest chat message of each conversation: a client waiting, or the team answering. */
export const chatEvents = (messages, conversations) => {
  const convo = new Map(conversations.map((c) => [idOf(c), c]));
  const latest = new Map();
  for (const m of messages) {
    const k = idOf(m.conversationId);
    if (!latest.has(k) || new Date(m.createdAt) > new Date(latest.get(k).createdAt)) latest.set(k, m);
  }
  return [...latest.values()]
    .filter((m) => m.senderType === 'client' || m.senderType === 'staff')
    .map((m) => {
      const who = nameOr(convo.get(idOf(m.conversationId))?.clientName, 'a client');
      return { kind: 'chat', at: m.createdAt, text: m.senderType === 'staff' ? `Client chat answered — ${who}` : `${who} wrote in client chat`, refType: 'conversation', refId: idOf(m.conversationId) };
    });
};

/** A case's newest step since [since]: opened, moved on (with its status as a tag), a call / WhatsApp / note logged, given to someone. */
export const caseEvents = (cases, since) =>
  cases.flatMap((c) => {
    const tag = CASE_STATUS_LABELS[c.status] ?? '';
    const name = `Case ${c.caseNumber ?? ''}`.trim();
    const steps = (c.activities ?? []).filter((a) => a.at && new Date(a.at) >= since).sort((x, y) => new Date(y.at) - new Date(x.at));
    const opened = c.createdAt && new Date(c.createdAt) >= since;
    const last = steps[0];
    if (!last && !opened) return [];
    if (!last || (opened && new Date(c.createdAt) >= new Date(last.at))) return [{ kind: 'case', at: c.createdAt, text: `${name} opened — ${nameOr(c.title, nameOr(c.customerName, 'a client'))}`, tag, refType: 'case', refId: idOf(c) }];
    const by = last.byName ? ` by ${last.byName}` : '';
    const text = {
      status: `${name} updated to`,
      call: `${name}: ${nameOr(c.customerName, 'the client')} called${by}`,
      whatsapp: `${name}: WhatsApp to ${nameOr(c.customerName, 'the client')}${by}`,
      assign: `${name} assigned${last.text ? ` — ${last.text}` : ''}`,
      note: `${name}: note added${by}`,
    }[last.type] ?? `${name} updated`;
    return [{ kind: 'case', at: last.at, text, tag: last.type === 'status' || last.type === 'assign' ? tag : '', refType: 'case', refId: idOf(c) }];
  });

/** Reviews handed in by brides since [since]. */
export const reviewEvents = (reviews, since) =>
  reviews
    .filter((r) => r.submittedAt && new Date(r.submittedAt) >= since)
    .map((r) => ({ kind: 'review', at: r.submittedAt, text: `${nameOr(r.brideName, 'A bride')} sent her review${Number.isFinite(Number(r.nps)) && r.nps != null ? ` (would recommend: ${r.nps}/10)` : ''}`, refType: 'review', refId: idOf(r) }));

/** All of them, newest first, at most [limit]. */
export const mergeFeed = (lists, limit = 8) =>
  lists
    .flat()
    .filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit)
    .map((e) => ({ ...e, at: new Date(e.at).toISOString() }));

/** A trial as the dashboard lists it: what, for whom, when, with whom (no phone). */
export const trialLine = (t) => {
  const items = t.trialItems ?? [];
  const what = nameOr(items.find((i) => i.packageName)?.packageName ?? items.find((i) => i.lookLabel)?.lookLabel, 'Trial');
  return {
    id: idOf(t),
    trialNumber: t.trialNumber ?? '',
    clientName: nameOr(t.clientName, 'Client'),
    what,
    date: t.trialDate ?? '',
    startTime: t.startTime ?? '',
    status: t.status ?? 'scheduled',
    artists: (t.assignedStaff ?? []).map((a) => a.artistName).filter(Boolean),
    owner: t.crmOwnerName ?? '',
  };
};
