import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Booking from '../models/Booking.js';

dotenv.config();

// Helper functions matching corrected backend logic
const parseDateOnlyValue = (value) => {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const stringValue = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stringValue);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
};

const formatDateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const normalizeSelectedDates = (selectedDates = [], fallbackDate = null) => {
  const source = Array.isArray(selectedDates) ? selectedDates : [];
  const normalized = source
    .map(parseDateOnlyValue)
    .filter((date) => date != null)
    .sort((a, b) => a.getTime() - b.getTime());

  const uniqueDates = [];
  const seen = new Set();
  for (const date of normalized) {
    const key = formatDateKey(date);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueDates.push(key);
  }

  if (uniqueDates.length > 0) return uniqueDates;

  const parsedFallback = parseDateOnlyValue(fallbackDate);
  if (parsedFallback) {
    return [formatDateKey(parsedFallback)];
  }

  return [];
};

const mergeDateAndTime = (dateOnly, timeSource, fallbackHour, fallbackMinute) => {
  const sourceDate = timeSource ? new Date(timeSource) : null;
  let hour = fallbackHour;
  let minute = fallbackMinute;

  if (sourceDate && !Number.isNaN(sourceDate.getTime())) {
    // Convert sourceDate to Asia/Kolkata (+5:30) timezone before extracting hours and minutes
    const adjusted = new Date(sourceDate.getTime() + 5.5 * 60 * 60 * 1000);
    hour = adjusted.getUTCHours();
    minute = adjusted.getUTCMinutes();
  }

  // Construct in Asia/Kolkata timezone and convert back to UTC
  const mergedUtc = Date.UTC(
    dateOnly.getFullYear(),
    dateOnly.getMonth(),
    dateOnly.getDate(),
    hour,
    minute,
    0,
    0
  ) - 5.5 * 60 * 60 * 1000;

  return new Date(mergedUtc);
};

const resolveSchedule = ({
  selectedDates,
  bookingDate,
  serviceStart,
  serviceEnd,
  currentBooking,
}) => {
  const resolvedSelectedDates = normalizeSelectedDates(
    selectedDates,
    bookingDate ?? currentBooking?.bookingDate ?? serviceStart
  );

  const baseDates =
    resolvedSelectedDates.length > 0
      ? resolvedSelectedDates
      : normalizeSelectedDates(currentBooking?.selectedDates, currentBooking?.bookingDate);

  const firstDate =
    parseDateOnlyValue(baseDates[0]) ??
    new Date(currentBooking?.bookingDate ?? bookingDate ?? Date.now());
  const lastDate = parseDateOnlyValue(baseDates[baseDates.length - 1]) ?? firstDate;

  return {
    selectedDates: baseDates,
    bookingDateValue: firstDate,
    serviceStartValue: mergeDateAndTime(
      firstDate,
      serviceStart ?? currentBooking?.serviceStart,
      9,
      0
    ),
    serviceEndValue: mergeDateAndTime(
      lastDate,
      serviceEnd ?? currentBooking?.serviceEnd,
      10,
      0
    ),
  };
};

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to database.');

    const bookings = await Booking.find({});
    console.log(`Analyzing ${bookings.length} bookings...`);

    let updatedCount = 0;

    for (const booking of bookings) {
      const schedule = resolveSchedule({
        selectedDates: booking.selectedDates,
        bookingDate: booking.bookingDate,
        serviceStart: booking.serviceStart,
        serviceEnd: booking.serviceEnd,
      });

      const oldStart = booking.serviceStart.toISOString();
      const oldEnd = booking.serviceEnd.toISOString();
      const newStart = schedule.serviceStartValue.toISOString();
      const newEnd = schedule.serviceEndValue.toISOString();

      if (oldStart !== newStart || oldEnd !== newEnd) {
        console.log(`Updating booking: ${booking.bookingNumber} (${booking.customerName})`);
        console.log(`  Start: ${oldStart} => ${newStart}`);
        console.log(`  End:   ${oldEnd} => ${newEnd}`);

        booking.serviceStart = schedule.serviceStartValue;
        booking.serviceEnd = schedule.serviceEndValue;
        booking.bookingDate = schedule.bookingDateValue;
        booking.selectedDates = schedule.selectedDates;

        // Also update sub-items (bookingItems) dates if they have any assigned staff schedule or if we want them aligned.
        if (booking.bookingItems && booking.bookingItems.length > 0) {
          booking.bookingItems.forEach((item) => {
            if (item.selectedDates && item.selectedDates.length > 0) {
              item.selectedDates = normalizeSelectedDates(item.selectedDates, schedule.bookingDateValue);
            }
          });
        }

        await booking.save();
        updatedCount++;
      }
    }

    console.log(`\nMigration completed. Updated ${updatedCount} bookings.`);
    process.exit(0);
  } catch (err) {
    console.error('Error during migration:', err);
    process.exit(1);
  }
};

run();
