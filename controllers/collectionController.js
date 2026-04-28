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
    const { status, bookingId, employeeId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (bookingId) filter.bookingId = bookingId;
    if (employeeId) filter.employeeId = employeeId;

    const collections = await Collection.find(filter)
      .populate(collectionPopulate)
      .sort({ date: -1, createdAt: -1 });
    res.json(collections);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCollection = async (req, res) => {
  const { bookingId, employeeId, amount, date, paymentMode, notes } = req.body;

  try {
    const collection = await Collection.create({
      bookingId,
      employeeId,
      amount: Number(amount) || 0,
      date: date ?? new Date(),
      paymentMode: paymentMode ?? 'cash',
      notes: notes ?? '',
    });

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

    if (collection.status === 'verified') {
      return res.status(400).json({ message: 'Cannot delete a verified collection' });
    }

    await collection.deleteOne();
    res.json({ message: 'Collection removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
