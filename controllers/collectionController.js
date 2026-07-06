import mongoose from 'mongoose';
import Collection from '../models/Collection.js';
import Booking from '../models/Booking.js';

const collectionPopulate = [
  { path: 'bookingId', select: 'bookingNumber customerName service totalOverAll status' },
  { path: 'employeeId', select: 'name phone artistRole status' },
  { path: 'verifiedBy', select: 'name role' },
];

/**
 * Recalculates the sum of all verified collections for a booking and
 * writes it to Booking.collectedAmount.  Call this after any status change
 * or deletion of a Collection document.
 */
const syncBookingCollectedAmount = async (bookingId) => {
  if (!bookingId) return;
  const verifiedCollections = await Collection.find({
    bookingId,
    status: 'verified',
  }).select('amount');
  const totalCollected = verifiedCollections.reduce(
    (sum, c) => sum + (Number(c.amount) || 0),
    0
  );
  await Booking.findByIdAndUpdate(bookingId, { collectedAmount: totalCollected });
};

export const getCollections = async (req, res) => {
  try {
    const { status, bookingId, employeeId, paymentMode, startDate, endDate } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (bookingId) filter.bookingId = bookingId;
    
    // Role-based scoping
    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver')) {
      filter.employeeId = req.user.employeeId;
    } else if (employeeId) {
      filter.employeeId = employeeId;
    }

    if (paymentMode) filter.paymentMode = paymentMode;
    
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    const collections = await Collection.find(filter)
      .populate(collectionPopulate)
      .sort({ date: -1, createdAt: -1 });
    res.json(collections);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCollection = async (req, res) => {
  const { bookingId, employeeId, amount, date, paymentMode, notes, attachmentUrl } = req.body;
  
  try {
    let finalEmployeeId = employeeId;
    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver')) {
      finalEmployeeId = req.user.employeeId;
    }

    const amountNum = Number(amount) || 0;

    const collection = new Collection({
      bookingId,
      employeeId: finalEmployeeId,
      amount: amountNum,
      date: date ?? new Date(),
      paymentMode: paymentMode ?? 'cash',
      notes: notes ?? '',
      attachmentUrl: attachmentUrl || null,
    });

    await collection.save();

    const populated = await Collection.findById(collection._id).populate(collectionPopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyCollection = async (req, res) => {
  try {
    if (req.user && req.user.role !== 'admin' && req.user.role !== 'accounts') {
      return res.status(403).json({ message: 'Not authorized to verify collections' });
    }

    const collection = await Collection.findById(req.params.id);
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }

    const { status, verifiedBy } = req.body;
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    collection.status = status;
    collection.verifiedBy = verifiedBy;
    collection.verifiedAt = new Date();

    await collection.save();

    // ─── Sync booking.collectedAmount ─────────────────────────────────────────
    // After any status change (verified or rejected), recalculate the total of
    // all *verified* collections for this booking and persist it so the invoice
    // screen always has an accurate balance without a separate query.
    await syncBookingCollectedAmount(collection.bookingId);
    // ──────────────────────────────────────────────────────────────────────────

    const populated = await Collection.findById(collection._id).populate(collectionPopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCollection = async (req, res) => {
  try {
    const collection = await Collection.findById(req.params.id);
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }

    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver') && String(collection.employeeId) !== String(req.user.employeeId)) {
      return res.status(403).json({ message: 'Not authorized to delete this collection' });
    }

    // Restriction removed as per user request: Admin/Accounts need to be able to delete entries.
    /*
    if (collection.status === 'verified') {
      return res.status(400).json({ message: 'Cannot delete a verified collection' });
    }
    */

    const bookingId = collection.bookingId;
    await collection.deleteOne();

    // ─── Sync booking.collectedAmount after deletion ───────────────────────────
    // If the deleted collection was verified, the booking balance must be updated.
    await syncBookingCollectedAmount(bookingId);
    // ──────────────────────────────────────────────────────────────────────────

    res.json({ message: 'Collection removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
