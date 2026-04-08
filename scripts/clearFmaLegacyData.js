import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';

dotenv.config();

const FMA_REGEX = /\bFMA\b/i;

const buildFmaBookingQuery = () => ({
  $or: [
    { customerName: FMA_REGEX },
    { service: FMA_REGEX },
    { temporaryStaffDetails: FMA_REGEX },
    { internalRemarks: FMA_REGEX },
    { 'assignedStaff.artistName': FMA_REGEX },
    { 'bookingItems.assignedStaff.artistName': FMA_REGEX },
  ],
});

const main = async () => {
  try {
    await connectDB();

    const bookingQuery = buildFmaBookingQuery();
    const matchingBookings = await Booking.find(bookingQuery, '_id bookingNumber customerName service');

    if (matchingBookings.length === 0) {
      console.log('No FMA-marked bookings found.');
      return;
    }

    const deleteResult = await Booking.deleteMany(bookingQuery);

    const fmaEmployee = await Employee.findOne({ name: /^FMA$/i });
    let removedEmployee = false;

    if (fmaEmployee) {
      const bookingsStillUsingFma = await Booking.exists({
        $or: [
          { 'assignedStaff.employeeId': fmaEmployee._id },
          { 'bookingItems.assignedStaff.employeeId': fmaEmployee._id },
          { 'assignedStaff.artistName': FMA_REGEX },
          { 'bookingItems.assignedStaff.artistName': FMA_REGEX },
        ],
      });

      if (!bookingsStillUsingFma) {
        await Employee.deleteOne({ _id: fmaEmployee._id });
        removedEmployee = true;
      }
    }

    console.log('FMA legacy cleanup complete.');
    console.log(`Bookings deleted: ${deleteResult.deletedCount}`);
    console.log(`FMA employee removed: ${removedEmployee ? 'yes' : 'no'}`);
    console.log('Deleted booking refs:');
    matchingBookings.forEach((booking) => {
      console.log(
        `- ${booking.bookingNumber || booking._id}: ${booking.customerName} | ${booking.service}`
      );
    });
  } catch (error) {
    console.error(`Failed to clear FMA legacy data: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
