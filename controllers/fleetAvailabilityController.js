import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { isDay } from '../utils/istDate.js';
import { isBlocking } from '../utils/fleetAvailability.js';
import { assignmentProblems, availabilityForBooking, availabilityForDay } from '../services/fleetAvailability.js';

const fail = (res, err) => res.status(err.status ?? 500).json({ message: err.message });

// @route GET /api/fleet/availability/booking/:id
// How every active driver and every vehicle stands for ONE booking's days (free / tight / busy /
// unavailable, and why) — what the assignment pickers are marked with.
export const getBookingAvailability = async (req, res) => {
  try {
    res.json(await availabilityForBooking(req.params.id));
  } catch (err) {
    fail(res, err);
  }
};

// @route GET /api/fleet/availability/day?date=YYYY-MM-DD
// The fleet board for a day: each vehicle and driver with their works, anything double-booked, and the
// works still needing a driver or vehicle.
export const getDayAvailability = async (req, res) => {
  try {
    const date = String(req.query.date ?? '').trim();
    if (!isDay(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      return res.status(400).json({ message: 'Choose a day (YYYY-MM-DD).' });
    }
    res.json(await availabilityForDay(date));
  } catch (err) {
    fail(res, err);
  }
};

// @route POST /api/fleet/availability/check   { bookingId, driverId?, vehicleId? }
// What putting this driver / vehicle on this booking would run into, before saving it.
export const checkAssignment = async (req, res) => {
  try {
    const { bookingId, driverId, vehicleId } = req.body ?? {};
    if (!mongoose.isValidObjectId(bookingId)) return res.status(400).json({ message: 'That booking is not valid' });
    const booking = await Booking.findById(bookingId)
      .select('bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd bookingItems.selectedDates bookingItems.startTime bookingItems.endTime pincode address')
      .lean();
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    const problems = await assignmentProblems({
      booking,
      driverId: mongoose.isValidObjectId(driverId) ? String(driverId) : '',
      vehicleId: mongoose.isValidObjectId(vehicleId) ? String(vehicleId) : '',
    });
    res.json({ ok: !problems.some(isBlocking), problems });
  } catch (err) {
    fail(res, err);
  }
};
