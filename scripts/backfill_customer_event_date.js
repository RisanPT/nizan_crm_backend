import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Customer from '../models/Customer.js';
import Booking from '../models/Booking.js';

dotenv.config({ path: '../.env' });

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

const backfillEventDates = async () => {
  await connectDB();

  console.log('Starting backfill for Customer eventDate...');

  // Find all customers where eventDate is either missing, null, or empty string
  const customers = await Customer.find({
    $or: [{ eventDate: { $exists: false } }, { eventDate: null }, { eventDate: '' }]
  });

  console.log(`Found ${customers.length} customers needing an eventDate.`);

  let updatedCount = 0;

  for (const customer of customers) {
    const query = [];
    if (customer.email && !customer.email.includes('@placeholder')) {
      query.push({ email: customer.email });
    }
    if (customer.phone) {
      query.push({ phone: customer.phone });
    }

    if (query.length === 0) {
      continue;
    }

    // Find the most recent booking for this customer
    const booking = await Booking.findOne({ $or: query }).sort({ bookingDate: -1, createdAt: -1 });

    if (booking && booking.bookingDate) {
      // Create date format YYYY-MM-DD
      let dateValue = booking.bookingDate;
      if (dateValue instanceof Date) {
        dateValue = dateValue.toISOString().split('T')[0];
      }

      customer.eventDate = dateValue;
      await customer.save();
      updatedCount++;
      console.log(`Updated customer ${customer.name} with eventDate ${dateValue}`);
    }
  }

  console.log(`Backfill complete. Updated ${updatedCount} customers.`);
  process.exit();
};

backfillEventDates();
