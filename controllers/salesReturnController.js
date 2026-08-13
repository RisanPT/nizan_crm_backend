import SalesReturn from '../models/SalesReturn.js';
import { notifyRoles } from '../utils/notify.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';

const populate = [
  { path: 'bookingId', select: 'bookingDate customer package totalAmount' },
  { path: 'customerId', select: 'name phone' },
  { path: 'approvedBy', select: 'name role' },
  { path: 'processedBy', select: 'name role' },
  { path: 'createdBy', select: 'name role' },
];

// ── GET all ─────────────────────────────────────────────────────────────────
export const getSalesReturns = async (req, res) => {
  try {
    const { status, startDate, endDate, search } = req.query;
    const filter = {};

    if (status && status !== 'all') filter.status = status;

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    if (search) {
      const r = new RegExp(search, 'i');
      filter.$or = [
        { brideName: r },
        { creditNoteNumber: r },
        { originalInvoiceRef: r },
        { reason: r },
      ];
    }

    const returns = await SalesReturn.find(filter)
      .populate(populate)
      .sort({ date: -1, createdAt: -1 });

    res.json(returns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET stats ────────────────────────────────────────────────────────────────
export const getSalesReturnStats = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const all = await SalesReturn.find({});
    let totalAmount = 0;
    let thisMonthAmount = 0;
    let pendingCount = 0;
    let processedAmount = 0;

    for (const r of all) {
      const amt = Number(r.amount) || 0;
      totalAmount += amt;
      if (r.status === 'processed') processedAmount += amt;
      if (r.status === 'draft' || r.status === 'approved') pendingCount++;
      const d = new Date(r.date);
      if (d >= startOfMonth && d <= endOfMonth) thisMonthAmount += amt;
    }

    res.json({
      totalCount: all.length,
      totalAmount,
      thisMonthAmount,
      pendingCount,
      processedAmount,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET by id ────────────────────────────────────────────────────────────────
export const getSalesReturnById = async (req, res) => {
  try {
    const doc = await SalesReturn.findById(req.params.id).populate(populate);
    if (!doc) return res.status(404).json({ message: 'Sales return not found' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── CREATE ───────────────────────────────────────────────────────────────────
export const createSalesReturn = async (req, res) => {
  try {
    const {
      creditNoteNumber,
      bookingId,
      originalInvoiceRef,
      customerId,
      brideName,
      amount,
      date,
      reason,
      paymentMode,
      attachmentUrl,
      notes,
    } = req.body;

    const doc = new SalesReturn({
      creditNoteNumber,
      bookingId: bookingId || null,
      originalInvoiceRef: originalInvoiceRef || '',
      customerId: customerId || null,
      brideName,
      amount: Number(amount) || 0,
      date: date ? new Date(date) : new Date(),
      reason,
      paymentMode: paymentMode || 'bank_transfer',
      attachmentUrl: attachmentUrl || '',
      notes: notes || '',
      createdBy: req.user?._id || null,
      status: 'draft',
    });

    await doc.save();

    await notifyRoles({
      roles: ['accounts', 'admin'],
      type: 'sales_return_created',
      title: 'New Sales Return / Credit Note',
      body: `₹${doc.amount.toLocaleString('en-IN')} credit note for ${brideName} (${creditNoteNumber}).`,
      link: '/accounts/sales-returns',
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    await safePost(() => postDoc('SalesReturn', doc.toObject(), req.user?._id || null));
    const populated = await SalesReturn.findById(doc._id).populate(populate);
    res.status(201).json(populated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Credit note number already exists' });
    }
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE ───────────────────────────────────────────────────────────────────
export const updateSalesReturn = async (req, res) => {
  try {
    const doc = await SalesReturn.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Sales return not found' });

    const {
      creditNoteNumber,
      bookingId,
      originalInvoiceRef,
      customerId,
      brideName,
      amount,
      date,
      reason,
      paymentMode,
      attachmentUrl,
      notes,
    } = req.body;

    if (creditNoteNumber !== undefined) doc.creditNoteNumber = creditNoteNumber;
    if (bookingId !== undefined) doc.bookingId = bookingId || null;
    if (originalInvoiceRef !== undefined) doc.originalInvoiceRef = originalInvoiceRef;
    if (customerId !== undefined) doc.customerId = customerId || null;
    if (brideName !== undefined) doc.brideName = brideName;
    if (amount !== undefined) doc.amount = Number(amount) || 0;
    if (date !== undefined) doc.date = new Date(date);
    if (reason !== undefined) doc.reason = reason;
    if (paymentMode !== undefined) doc.paymentMode = paymentMode;
    if (attachmentUrl !== undefined) doc.attachmentUrl = attachmentUrl;
    if (notes !== undefined) doc.notes = notes;

    await doc.save();
    await safePost(() => postDoc('SalesReturn', doc.toObject(), req.user?._id || null));
    const populated = await SalesReturn.findById(doc._id).populate(populate);
    res.json(populated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Credit note number already exists' });
    }
    res.status(500).json({ message: err.message });
  }
};

// ── APPROVE / PROCESS (status change) ───────────────────────────────────────
export const updateSalesReturnStatus = async (req, res) => {
  try {
    const doc = await SalesReturn.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Sales return not found' });

    const { status } = req.body;
    if (!['draft', 'approved', 'processed', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    doc.status = status;

    if (status === 'approved') {
      doc.approvedBy = req.user?._id || null;
      doc.approvedAt = new Date();
    }

    if (status === 'processed') {
      doc.processedBy = req.user?._id || null;
      doc.processedAt = new Date();
    }

    await doc.save();
    await safePost(() => postDoc('SalesReturn', doc.toObject(), req.user?._id || null));
    const populated = await SalesReturn.findById(doc._id).populate(populate);
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE ───────────────────────────────────────────────────────────────────
export const deleteSalesReturn = async (req, res) => {
  try {
    const doc = await SalesReturn.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Sales return not found' });
    await doc.deleteOne();
    await safePost(() => unpostDoc('SalesReturn', doc._id));
    res.json({ message: 'Sales return deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
