import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import WhatsAppSend from '../models/WhatsAppSend.js';
import {
  isTeamnChatConfigured,
  pingTeamnChat,
  sendTeamnChatDocument,
  toWhatsAppPhone,
} from '../utils/teamnChat.js';
import { htmlToPdf } from '../utils/htmlToPdf.js';

// Invoices carry GST figures, so only Accounts send them; any signed-in user
// who can open the sales workspace may send a quotation.
const INVOICE_ROLES = ['admin', 'accounts', 'finance_head'];

// Requests running right now — a double-click on the CRM side must never send
// the same PDF twice (TeamN Chat has no de-duplication).
const inFlight = new Set();

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const safeFilenamePart = (s) =>
  String(s ?? '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);

// @route GET /api/whatsapp/status — is the server holding a key? (never the key itself)
export const getWhatsAppStatus = (req, res) => {
  res.json({ configured: isTeamnChatConfigured() });
};

// @route GET /api/whatsapp/ping — admin "test connection"
export const pingWhatsApp = async (req, res) => {
  const { status, body } = await pingTeamnChat();
  res.status(status >= 200 && status < 600 ? status : 502).json(body);
};

/**
 * @route POST /api/whatsapp/:mode   (mode = handover | send)
 * multipart: file (PDF), kind (quotation|invoice), and
 *   • invoice   → bookingId; reference / name / phone / date are read from the booking
 *   • quotation → reference, customer_name, phone
 */
export const sendWhatsAppDocument = async (req, res) => {
  const mode = req.params.mode === 'send' ? 'send' : 'handover';
  const kind = String(req.body.kind || '').toLowerCase();
  // 'confirmation' = the Booking Confirmation PDF from the Bookings list.
  // TeamN Chat has no confirmation template, so it goes out with the
  // invoice template (decided by the business), referenced by booking number.
  if (!['quotation', 'invoice', 'confirmation'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'kind must be quotation, invoice or confirmation.' });
  }
  // Either a ready PDF, or the CRM's own print HTML (field `html`), which is
  // rendered here with headless Chrome so the customer gets exactly the page
  // "Print Full GST Invoice" produces.
  let pdf = req.file?.buffer;
  if ((!pdf || pdf.length === 0) && typeof req.body.html === 'string' && req.body.html.trim()) {
    try {
      pdf = await htmlToPdf(req.body.html);
    } catch (err) {
      console.error('htmlToPdf failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Could not create the invoice PDF on the server. Nothing was sent.' });
    }
  }
  if (!pdf || pdf.length === 0) {
    return res.status(400).json({ ok: false, error: 'No PDF was attached.' });
  }
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ ok: false, error: 'The attached file is not a PDF.' });
  }

  let reference;
  let customerName;
  let phone;
  let bookingDate = '';
  let bookingId = null;

  if (kind === 'invoice') {
    if (!INVOICE_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ ok: false, error: 'Only Accounts can send invoices on WhatsApp.' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.body.bookingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking.' });
    }
    const booking = await Booking.findById(req.body.bookingId)
      .select('invoiceNumber customerName phone bookingDate serviceStart')
      .lean();
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });
    // The tax invoice exists only once fully paid (utils/invoiceNumber.js).
    if (!booking.invoiceNumber) {
      return res.status(400).json({ ok: false, error: 'This booking has no invoice number yet — it is issued once fully paid.' });
    }
    bookingId = booking._id;
    reference = booking.invoiceNumber;
    customerName = booking.customerName || '';
    phone = toWhatsAppPhone(booking.phone);
    const eventDate = booking.bookingDate || booking.serviceStart;
    bookingDate = eventDate ? IST_DATE.format(new Date(eventDate)) : '';
    if (!bookingDate) {
      return res.status(400).json({ ok: false, error: 'This booking has no event date for the invoice message.' });
    }
  } else if (kind === 'confirmation') {
    if (!mongoose.Types.ObjectId.isValid(req.body.bookingId)) {
      return res.status(400).json({ ok: false, error: 'Invalid booking.' });
    }
    const booking = await Booking.findById(req.body.bookingId)
      .select('bookingNumber customerName phone bookingDate serviceStart status')
      .lean();
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found.' });
    if (['cancelled', 'canceled', 'rejected'].includes(String(booking.status || '').toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'This booking is cancelled — no confirmation to send.' });
    }
    bookingId = booking._id;
    reference = String(booking.bookingNumber || booking._id);
    customerName = booking.customerName || '';
    phone = toWhatsAppPhone(booking.phone);
    const eventDate = booking.bookingDate || booking.serviceStart;
    bookingDate = eventDate ? IST_DATE.format(new Date(eventDate)) : '';
    if (!bookingDate) {
      return res.status(400).json({ ok: false, error: 'This booking has no event date for the message.' });
    }
  } else {
    reference = String(req.body.reference || '').trim();
    customerName = String(req.body.customer_name || '').trim();
    phone = toWhatsAppPhone(req.body.phone);
    if (!reference || !customerName) {
      return res.status(400).json({ ok: false, error: 'Quotation number and customer name are required.' });
    }
  }
  if (phone.length < 11 || phone.length > 15) {
    return res.status(400).json({ ok: false, error: "The customer's WhatsApp number is missing or invalid." });
  }

  const lockKey = `${mode}|${kind}|${reference}|${phone}`;
  if (inFlight.has(lockKey)) {
    return res.status(409).json({ ok: false, error: 'This document is already being sent — please wait.' });
  }
  inFlight.add(lockKey);

  const filename = `${kind === 'invoice' ? 'Invoice' : kind === 'confirmation' ? 'Booking_Confirmation' : 'Quotation'}_${safeFilenamePart(reference)}_${safeFilenamePart(customerName) || 'Customer'}.pdf`;
  const sentByName = req.user?.name || req.user?.email || '';

  try {
    const { status, body } = await sendTeamnChatDocument(mode, {
      pdf,
      filename,
      phone,
      // TeamN Chat template: confirmations use the invoice template.
      kind: kind === 'confirmation' ? 'invoice' : kind,
      reference,
      customerName,
      bookingDate,
      sentBy: sentByName,
    });

    // Best-effort audit row — a logging hiccup never hides the send result.
    try {
      await WhatsAppSend.create({
        mode,
        kind,
        reference,
        bookingId,
        customerName,
        phone,
        filename,
        sizeBytes: pdf.length,
        ok: body.ok === true,
        httpStatus: status,
        error: body.ok === true ? '' : String(body.error || ''),
        documentId: body.document_id != null ? String(body.document_id) : '',
        channel: body.channel || '',
        sentAs: body.sent_as || '',
        cost: Number(body.cost) || 0,
        sentBy: req.user?._id || null,
        sentByName,
      });
    } catch (logErr) {
      console.error('WhatsAppSend log failed:', logErr.message);
    }

    res.status(body.ok === true ? 200 : status >= 400 ? status : 502).json(body);
  } finally {
    inFlight.delete(lockKey);
  }
};

// @route GET /api/whatsapp/history?bookingId= — what the CRM already sent
export const getWhatsAppHistory = async (req, res) => {
  try {
    const q = {};
    if (req.query.bookingId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.bookingId)) return res.json([]);
      q.bookingId = req.query.bookingId;
    }
    if (req.query.reference) q.reference = String(req.query.reference);
    const rows = await WhatsAppSend.find(q).sort({ createdAt: -1 }).limit(50).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
