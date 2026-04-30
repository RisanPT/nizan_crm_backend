import mongoose from 'mongoose';
import Collection from '../models/Collection.js';
import Booking from '../models/Booking.js';

const collectionPopulate = [
  { path: 'bookingId', select: 'bookingNumber customerName service totalOverAll status' },
  { path: 'employeeId', select: 'name phone artistRole status' },
  { path: 'verifiedBy', select: 'name role' },
];

export const getCollections = async (req, res) => {
  try {
    const { status, bookingId, employeeId, paymentMode, startDate, endDate } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (bookingId) filter.bookingId = bookingId;
    if (employeeId) filter.employeeId = employeeId;
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
    const amountNum = Number(amount) || 0;

    const collection = new Collection({
      bookingId,
      employeeId,
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

    // Restriction removed as per user request: Admin/Accounts need to be able to delete entries.
    /*
    if (collection.status === 'verified') {
      return res.status(400).json({ message: 'Cannot delete a verified collection' });
    }
    */

    await collection.deleteOne();
    res.json({ message: 'Collection removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
