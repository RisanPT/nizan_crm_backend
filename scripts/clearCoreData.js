import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Customer from '../models/Customer.js';
import Booking from '../models/Booking.js';
import Package from '../models/Package.js';

dotenv.config();

async function clearCoreData() {
  try {
    await connectDB();

    const [customersResult, bookingsResult, packagesResult] =
      await Promise.all([
        Customer.deleteMany({}),
        Booking.deleteMany({}),
        Package.deleteMany({}),
      ]);

    console.log('Core data cleared successfully.');
    console.log(`Customers deleted: ${customersResult.deletedCount}`);
    console.log(`Bookings deleted: ${bookingsResult.deletedCount}`);
    console.log(`Packages deleted: ${packagesResult.deletedCount}`);
  } catch (error) {
    console.error(`Failed to clear core data: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

clearCoreData();
