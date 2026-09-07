import ArtistPayout from '../models/ArtistPayout.js';
import Employee from '../models/Employee.js';
import Booking from '../models/Booking.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';

const payoutPopulate = [
  { path: 'employeeId', select: 'name phone artistRole type status' },
  { path: 'bookingId', select: 'bookingNumber customerName service status' },
  { path: 'approvedBy', select: 'name role' },
  { path: 'paidBy', select: 'name role' },
];

// Create / approve / pay / edit / delete — Accounts & Admin only.
const canManage = (u) => ['admin', 'accounts'].includes(u?.role);
// Read — Accounts, Admin, plus management roles that need visibility
// (the Artist Head profile shows each freelancer's total paid, read-only).
// `artistHead` also covers a dual-role artist who leads the team (role stays
// 'artist' but carries the artistHead flag).
const canRead = (u) =>
  ['admin', 'accounts', 'manager', 'artist_head'].includes(u?.role) ||
  u?.artistHead === true;

// Ensure the Artist Payouts ledger head exists so the voucher can post even if
// the Chart of Accounts was seeded before this feature shipped. Best-effort.
const ensurePayoutAccount = async () => {
  try {
    await ChartOfAccount.updateOne(
      { code: 'APO-01' },
      {
        $setOnInsert: {
          code: 'APO-01',
          name: 'Artist Payouts',
          nature: 'expense',
          group: 'Direct / Job Expense',
          isSystem: true,
        },
      },
      { upsert: true }
    );
  } catch {
    // Non-fatal — posting is best-effort and will simply skip if missing.
  }
};

// @route GET /api/artist-payouts?status=&employeeId=&bookingId=&startDate=&endDate=&month=&year=
export const getPayouts = async (req, res) => {
  try {
    if (!canRead(req.user)) {
      return res.status(403).json({ message: 'Not authorized to view payouts' });
    }
    const { status, employeeId, bookingId, startDate, endDate, month, year } =
      req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (employeeId) filter.employeeId = employeeId;
    if (bookingId) filter.bookingId = bookingId;

    if (month && year) {
      const m = Number(month) - 1;
      const y = Number(year);
      filter.date = {
        $gte: new Date(y, m, 1),
        $lte: new Date(y, m + 1, 0, 23, 59, 59, 999),
      };
    } else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    const payouts = await ArtistPayout.find(filter)
      .populate(payoutPopulate)
      .sort({ date: -1, createdAt: -1 });
    res.json(payouts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/artist-payouts
export const createPayout = async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ message: 'Not authorized to create payouts' });
    }
    const { employeeId, bookingId, amount, date, paymentMode, notes } = req.body;
    if (!employeeId) {
      return res.status(400).json({ message: 'Select the artist to pay.' });
    }
    const amountNum = Number(amount) || 0;
    if (amountNum <= 0) {
      return res.status(400).json({ message: 'Enter a payout amount.' });
    }

    // Denormalize name + booking number for display and the ledger narration.
    const emp = await Employee.findById(employeeId).select('name').lean();
    let bookingNumber = '';
    if (bookingId) {
      const bk = await Booking.findById(bookingId).select('bookingNumber').lean();
      bookingNumber = bk?.bookingNumber || '';
    }

    const payout = await ArtistPayout.create({
      employeeId,
      employeeName: emp?.name || '',
      bookingId: bookingId || null,
      bookingNumber,
      amount: amountNum,
      date: date ?? new Date(),
      paymentMode: paymentMode ?? 'bank_transfer',
      notes: notes ?? '',
      createdBy: req.user?._id ?? null,
    });

    const populated = await ArtistPayout.findById(payout._id).populate(payoutPopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/artist-payouts/:id  (edit while not yet paid)
export const updatePayout = async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ message: 'Not authorized to edit payouts' });
    }
    const payout = await ArtistPayout.findById(req.params.id);
    if (!payout) return res.status(404).json({ message: 'Payout not found' });
    if (payout.status === 'paid') {
      return res
        .status(400)
        .json({ message: 'A paid payout is locked and cannot be edited.' });
    }

    const { amount, date, paymentMode, notes, bookingId } = req.body;
    if (amount !== undefined) payout.amount = Number(amount) || 0;
    if (date !== undefined) payout.date = date;
    if (paymentMode !== undefined) payout.paymentMode = paymentMode;
    if (notes !== undefined) payout.notes = notes ?? '';
    if (bookingId !== undefined) {
      payout.bookingId = bookingId || null;
      if (bookingId) {
        const bk = await Booking.findById(bookingId).select('bookingNumber').lean();
        payout.bookingNumber = bk?.bookingNumber || '';
      } else {
        payout.bookingNumber = '';
      }
    }

    await payout.save();
    const populated = await ArtistPayout.findById(payout._id).populate(payoutPopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/artist-payouts/:id/approve
export const approvePayout = async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ message: 'Not authorized to approve payouts' });
    }
    const payout = await ArtistPayout.findById(req.params.id);
    if (!payout) return res.status(404).json({ message: 'Payout not found' });
    if (payout.status === 'paid') {
      return res.status(400).json({ message: 'This payout is already paid.' });
    }

    payout.status = 'approved';
    payout.approvedBy = req.user?._id ?? null;
    payout.approvedAt = new Date();
    await payout.save();

    const populated = await ArtistPayout.findById(payout._id).populate(payoutPopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/artist-payouts/:id/pay
export const payPayout = async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ message: 'Not authorized to pay payouts' });
    }
    const payout = await ArtistPayout.findById(req.params.id);
    if (!payout) return res.status(404).json({ message: 'Payout not found' });

    const { paymentMode } = req.body;
    if (paymentMode) payout.paymentMode = paymentMode;
    payout.status = 'paid';
    payout.paidBy = req.user?._id ?? null;
    payout.paidAt = new Date();
    await payout.save();

    // Post to the ledger as a Payment against the Artist Payouts head (COGS).
    await ensurePayoutAccount();
    await safePost(() =>
      postDoc('ArtistPayout', payout.toObject(), req.user?._id || null)
    );

    const populated = await ArtistPayout.findById(payout._id).populate(payoutPopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/artist-payouts/:id
export const deletePayout = async (req, res) => {
  try {
    if (!canManage(req.user)) {
      return res.status(403).json({ message: 'Not authorized to delete payouts' });
    }
    const payout = await ArtistPayout.findById(req.params.id);
    if (!payout) return res.status(404).json({ message: 'Payout not found' });

    await payout.deleteOne();
    await safePost(() => unpostDoc('ArtistPayout', payout._id));

    res.json({ message: 'Payout removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
