import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Consultation from '../models/Consultation.js';
import Lead from '../models/Lead.js';
import StylistClient from '../models/StylistClient.js';
import {
  createClientFile,
  findTeamNClient,
  loadTeamNSource,
  refreshTeamNClient,
} from '../services/stylistClients.js';
import { LIGHT_SELECT, canSeeNotes } from '../utils/consultationRules.js';
import {
  CLIENT_COMPANIES,
  CLIENT_STATUSES,
  canActOnClient,
  cleanClientInput,
  clientProgress,
  snapshotFromTeamN,
} from '../utils/stylistClientRules.js';
import { isEligibleStylist } from './consultationController.js';
import { htmlToPdf } from '../utils/htmlToPdf.js';
import {
  MAX_REPORT_IMAGES,
  REPORT_SECTIONS,
  buildClientReportHtml,
  fetchImageDataUri,
} from '../utils/clientReport.js';

// Stylist client files — /api/stylist-clients. Mounted behind protect +
// attachRolePermissions + consultationGuard, so req.consultAccess is set.
// A stylist sees and edits only their own clients; a stylist lead sees all.

const isId = (v) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
const clean = (v) => String(v ?? '').trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A Team N client's details can be edited by hand, but "Refresh from booking"
// puts the booking's values back (see refreshTeamNClient).
const LIST_LIMIT = 300;

const loadClient = async (req, res) => {
  if (!isId(req.params.id)) {
    res.status(404).json({ message: 'Client not found' });
    return null;
  }
  const client = await StylistClient.findById(req.params.id);
  if (!client) {
    res.status(404).json({ message: 'Client not found' });
    return null;
  }
  if (!canActOnClient(req.consultAccess, req.user, client)) {
    res.status(403).json({ message: 'You can only open your own clients' });
    return null;
  }
  return client;
};

/// Who should own a new client: the caller, or (stylist leads only) someone
/// else who can take consultations. Returns { ok, id } or { ok:false, code, message }.
const resolveOwner = async (req, requested) => {
  if (!requested || String(requested) === String(req.user._id)) return { ok: true, id: req.user._id };
  if (!req.consultAccess.viewAll) {
    return { ok: false, code: 403, message: 'You can only add clients for yourself' };
  }
  if (!(await isEligibleStylist(String(requested)))) {
    return { ok: false, code: 400, message: 'That user cannot be assigned clients' };
  }
  return { ok: true, id: requested };
};

const withOwnerName = (q) => q.populate('stylistId', 'name');

// ── GET /api/stylist-clients ────────────────────────────────────────────────
// ?q= (name, phone, booking or client number) &company= &status= (default
// Active; 'all' for every status) &stylistId= (leads only) &sort=recent|event
export const listClients = async (req, res) => {
  try {
    const filter = {};
    const { company, status = 'Active', stylistId, sort = 'recent' } = req.query;

    if (company !== undefined && company !== '') {
      if (!CLIENT_COMPANIES.includes(company)) {
        return res.status(400).json({ message: `company must be one of ${CLIENT_COMPANIES.join(', ')}` });
      }
      filter.company = company;
    }
    if (status !== 'all') {
      if (!CLIENT_STATUSES.includes(status)) {
        return res.status(400).json({ message: `status must be one of ${CLIENT_STATUSES.join(', ')} or all` });
      }
      filter.status = status;
    }
    if (req.consultAccess.viewAll) {
      if (stylistId) {
        if (!isId(stylistId)) return res.status(400).json({ message: 'Invalid stylistId' });
        filter.stylistId = stylistId;
      }
    } else {
      filter.stylistId = req.user._id;
    }
    const q = clean(req.query.q);
    if (typeof req.query.q === 'string' && q.length > 0) {
      const rx = new RegExp(escapeRegex(q.slice(0, 60)), 'i');
      const digits = q.replace(/\D/g, '');
      filter.$or = [{ name: rx }, { bookingNumber: rx }, { clientNo: rx }];
      if (digits.length >= 3) {
        const phoneRx = new RegExp(escapeRegex(digits));
        filter.$or.push({ phone: phoneRx }, { altPhone: phoneRx });
      }
    }

    const clients = await withOwnerName(StylistClient.find(filter))
      .sort({ updatedAt: -1 })
      .limit(LIST_LIMIT)
      .lean();

    const calls = await Consultation.find({ clientId: { $in: clients.map((c) => c._id) } })
      .select('clientId status scheduledAt')
      .lean();
    const byClient = new Map();
    for (const c of calls) {
      const key = String(c.clientId);
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key).push(c);
    }

    const now = new Date();
    const rows = clients.map((c) => ({
      ...c,
      progress: clientProgress(byClient.get(String(c._id)), c.requiredCalls, now),
    }));
    if (sort === 'event') {
      // Soonest upcoming event first; clients without a future date last.
      const today = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
      const nextEvent = (c) => (c.eventDates ?? []).find((d) => d >= today) ?? '9999-12-31';
      rows.sort((a, b) => nextEvent(a).localeCompare(nextEvent(b)));
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/stylist-clients/team-n-search?q= ───────────────────────────────
// Team N leads and bookings matching a name, phone or booking number, for
// "add a Team N client". Each result says whether it already has a client file.
export const searchTeamN = async (req, res) => {
  try {
    const q = clean(typeof req.query.q === 'string' ? req.query.q : '').slice(0, 60);
    if (q.length < 2) return res.json([]);
    const rx = new RegExp(escapeRegex(q), 'i');
    const digits = q.replace(/\D/g, '');
    const phoneRx = digits.length >= 3 ? new RegExp(escapeRegex(digits)) : null;

    const [leads, bookings] = await Promise.all([
      Lead.find({
        $or: [{ name: rx }, ...(phoneRx ? [{ phone: phoneRx }, { alternateNumber: phoneRx }] : [])],
      })
        .select('name phone eventType eventDate bookingId status')
        .sort({ updatedAt: -1 })
        .limit(15)
        .lean(),
      Booking.find({
        $or: [{ customerName: rx }, { bookingNumber: rx }, ...(phoneRx ? [{ phone: phoneRx }] : [])],
      })
        .select('customerName phone bookingNumber selectedDates bookingDate leadId status')
        .sort({ bookingDate: -1 })
        .limit(15)
        .lean(),
    ]);

    // One row per lead; a booking joins its lead's row, or stands alone.
    const rows = new Map();
    for (const l of leads) {
      rows.set(`lead:${l._id}`, {
        leadId: l._id,
        bookingId: l.bookingId ?? null,
        name: l.name,
        phone: l.phone,
        eventType: l.eventType ?? '',
        eventDate: l.eventDate ?? null,
        bookingNumber: '',
        leadStatus: l.status ?? '',
      });
    }
    for (const b of bookings) {
      const key = b.leadId ? `lead:${b.leadId}` : `booking:${b._id}`;
      const row = rows.get(key) ?? {
        leadId: b.leadId ?? null,
        name: b.customerName,
        phone: b.phone ?? '',
        eventType: '',
        eventDate: null,
        leadStatus: '',
      };
      row.bookingId = b._id;
      row.bookingNumber = b.bookingNumber ?? '';
      row.bookingStatus = b.status ?? '';
      row.eventDate = row.eventDate ?? b.bookingDate ?? null;
      rows.set(key, row);
    }

    const list = [...rows.values()].slice(0, 20);
    const existing = await StylistClient.find({
      $or: [
        { leadId: { $in: list.map((r) => r.leadId).filter(Boolean) } },
        { bookingId: { $in: list.map((r) => r.bookingId).filter(Boolean) } },
      ],
    })
      .select('_id leadId bookingId stylistId')
      .lean();
    for (const row of list) {
      const match = existing.find(
        (c) =>
          (row.leadId && String(c.leadId) === String(row.leadId)) ||
          (row.bookingId && String(c.bookingId) === String(row.bookingId))
      );
      row.clientId = match?._id ?? null;
      // A stylist can't open another stylist's client, so don't offer it.
      row.clientIsOwn = match ? canActOnClient(req.consultAccess, req.user, match) : false;
    }
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stylist-clients ───────────────────────────────────────────────
// Team N: { company:'Team N', leadId? , bookingId?, stylistId?, notes?, requiredCalls? }
//   — every other field is filled in from the lead/booking.
// Nizan:  { company:'Nizan', name, phone, …details, stylistId? }
export const createClient = async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!CLIENT_COMPANIES.includes(body.company)) {
      return res.status(400).json({ message: `company must be one of ${CLIENT_COMPANIES.join(', ')}` });
    }
    const owner = await resolveOwner(req, body.stylistId);
    if (!owner.ok) return res.status(owner.code).json({ message: owner.message });

    const creator = { createdBy: req.user._id, createdByName: req.user.name ?? '' };
    let client;

    if (body.company === 'Team N') {
      const leadId = body.leadId ?? null;
      const bookingId = body.bookingId ?? null;
      if ((leadId !== null && !isId(leadId)) || (bookingId !== null && !isId(bookingId)) || (!leadId && !bookingId)) {
        return res.status(400).json({ message: 'Choose a Team N enquiry or booking' });
      }
      const { lead, booking } = await loadTeamNSource({ leadId, bookingId });
      if (!lead && !booking) return res.status(404).json({ message: 'That enquiry or booking no longer exists' });

      const existing = await findTeamNClient({ leadId: lead?._id, bookingId: booking?._id });
      if (existing) {
        return res.status(409).json({
          message: 'This client already has a client file',
          code: 'CLIENT_EXISTS',
          clientId: existing._id,
        });
      }
      const extra = cleanClientInput({ notes: body.notes, requiredCalls: body.requiredCalls }, { partial: true });
      if (!extra.ok) return res.status(400).json({ message: extra.message });

      client = await createClientFile({
        company: 'Team N',
        leadId: lead?._id ?? null,
        bookingId: booking?._id ?? null,
        ...snapshotFromTeamN(lead, booking),
        ...extra.value,
        syncedAt: new Date(),
        stylistId: owner.id,
        ...creator,
      });
    } else {
      const input = cleanClientInput(body);
      if (!input.ok) return res.status(400).json({ message: input.message });
      // Client details only — never let the body set links or ownership.
      delete input.value.bookingNumber;
      client = await createClientFile({ company: 'Nizan', ...input.value, stylistId: owner.id, ...creator });
    }

    const fresh = await withOwnerName(StylistClient.findById(client._id)).lean();
    res.status(201).json({ ...fresh, progress: clientProgress([], fresh.requiredCalls) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'This client already has a client file', code: 'CLIENT_EXISTS' });
    }
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/stylist-clients/:id ────────────────────────────────────────────
// The client file, their calls (oldest first) and every reference image the
// caller may see (images follow the call-notes permission).
export const getClient = async (req, res) => {
  try {
    const client = await loadClient(req, res);
    if (!client) return;

    const calls = await Consultation.find({ clientId: client._id })
      .select(`${LIGHT_SELECT.replace('-referenceImages', '')}`)
      .populate('stylistId', 'name')
      .sort({ scheduledAt: 1 })
      .lean();

    const images = [];
    const callList = calls.map((c) => {
      const mayRead = canSeeNotes(req.consultAccess, req.user, c);
      if (mayRead) {
        for (const img of c.referenceImages ?? []) {
          images.push({ ...img, consultationId: c._id, callNumber: c.callNumber ?? null, callAt: c.scheduledAt });
        }
      }
      const { referenceImages, ...rest } = c;
      return { ...rest, imageCount: mayRead ? (referenceImages ?? []).length : 0 };
    });

    const fresh = await withOwnerName(StylistClient.findById(client._id)).lean();
    res.json({
      ...fresh,
      progress: clientProgress(calls, fresh.requiredCalls),
      calls: callList,
      images,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/stylist-clients/:id ────────────────────────────────────────────
// Any detail field, plus status / requiredCalls; stylistId for leads only.
export const updateClient = async (req, res) => {
  try {
    const client = await loadClient(req, res);
    if (!client) return;
    const body = req.body ?? {};

    const input = cleanClientInput(body, { partial: true });
    if (!input.ok) return res.status(400).json({ message: input.message });
    // Team N booking numbers come from the booking, never typed.
    if (client.company === 'Team N') delete input.value.bookingNumber;
    Object.assign(client, input.value);

    if (body.stylistId !== undefined && String(body.stylistId) !== String(client.stylistId)) {
      if (!req.consultAccess.viewAll) {
        return res.status(403).json({ message: 'Only a stylist lead can move a client to another stylist' });
      }
      if (!isId(String(body.stylistId)) || !(await isEligibleStylist(String(body.stylistId)))) {
        return res.status(400).json({ message: 'That user cannot be assigned clients' });
      }
      client.stylistId = body.stylistId;
    }

    await client.save();
    const fresh = await withOwnerName(StylistClient.findById(client._id)).lean();
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/stylist-clients/:id/refresh ───────────────────────────────────
// Team N only: fill the file in again from the lead and booking.
export const refreshClient = async (req, res) => {
  try {
    const client = await loadClient(req, res);
    if (!client) return;
    if (client.company !== 'Team N') {
      return res.status(400).json({ message: 'Only a Team N client can be refreshed from a booking' });
    }
    const ok = await refreshTeamNClient(client);
    if (!ok) return res.status(404).json({ message: 'The enquiry and booking for this client no longer exist' });
    const fresh = await withOwnerName(StylistClient.findById(client._id)).lean();
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/stylist-clients/:id/report ─────────────────────────────────────
// The client report as a PDF: details, the agreed look, and every completed
// call with its notes and reference images. A call's notes and images appear
// only when the caller may read that call's notes (same rule as the app).

// Swappable in tests, so they never start Chrome or reach Cloudinary.
export const reportDeps = { htmlToPdf, fetchImage: fetchImageDataUri };

const NOTE_KEYS = [...REPORT_SECTIONS.map(([k]) => k), 'referenceImages'];

/// Runs [fn] over [items] with at most [limit] at a time.
const mapLimited = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const safeFilePart = (s) =>
  String(s ?? '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 50) || 'Client';

export const downloadClientReport = async (req, res) => {
  try {
    const client = await loadClient(req, res);
    if (!client) return;

    const raw = await Consultation.find({ clientId: client._id })
      .populate('stylistId', 'name')
      .sort({ scheduledAt: 1 })
      .lean();
    const calls = raw.map((c) => {
      const canRead = canSeeNotes(req.consultAccess, req.user, c);
      if (canRead) return { ...c, canRead };
      const hidden = { ...c, canRead };
      for (const k of NOTE_KEYS) delete hidden[k];
      return hidden;
    });

    // Embed the images of readable completed calls (the PDF renderer can't
    // fetch anything itself).
    const urls = [
      ...new Set(
        calls
          .filter((c) => c.canRead && c.status === 'Completed')
          .flatMap((c) => (c.referenceImages ?? []).map((i) => i.url))
      ),
    ].slice(0, MAX_REPORT_IMAGES);
    const data = await mapLimited(urls, 4, (u) => reportDeps.fetchImage(u));
    const images = new Map();
    urls.forEach((u, i) => {
      if (data[i]) images.set(u, data[i]);
    });

    const fresh = await withOwnerName(StylistClient.findById(client._id)).lean();
    const now = new Date();
    const html = buildClientReportHtml({
      client: fresh,
      calls,
      images,
      generatedBy: req.user.name ?? '',
      generatedAt: now,
    });
    const pdf = await reportDeps.htmlToPdf(html);

    const day = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
    const filename = `Client_Report_${safeFilePart(fresh.name)}_${day}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(pdf);
  } catch (err) {
    console.error('client report failed:', err.message);
    res.status(500).json({ message: 'Could not make the report. Try again in a minute.' });
  }
};
