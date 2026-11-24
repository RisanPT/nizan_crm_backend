// Helpers for the day-wise (morning / evening) booking-slot capacity system.

export const HALVES = ['morning', 'evening'];

const IST_OFFSET_MS = 330 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// Normalize any date to UTC midnight OF ITS INDIA (IST) CALENDAR DAY, so a
// whole day groups to one key. Booking / blocked dates are saved at midnight
// in the server's timezone: on a UTC server that is 00:00Z of the day, on an
// IST server 18:30Z of the day BEFORE. Reading the UTC date put the second
// kind one day early (a block on the 30th showed — and blocked bookings — on
// the 29th). The IST day is right for both.
export const dayKey = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return x; // caller checks isNaN
  const ist = new Date(x.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
};

// Mongo range for stored day values of the days [from, to) (both dayKey
// values). Shifted back 6 h so a day saved at IST midnight (18:30Z the day
// before) is inside its own day's window and out of the next day's.
export const dayWindow = (from, to) => ({
  $gte: new Date(new Date(from).getTime() - SIX_HOURS_MS),
  $lt: new Date(new Date(to).getTime() - SIX_HOURS_MS),
});

// Classify a free-text eventSlot ("Morning wedding", "Evening reception",
// "Muhurtham", "Night event", "") into a morning/evening half. Anything that
// reads as evening/night/reception → evening; everything else → morning.
// NOTE: match "evening" (not bare "even") so the common word "event" — as in
// "Morning event" — is NOT wrongly read as evening.
export const slotHalf = (eventSlot) => {
  const s = String(eventSlot || '').toLowerCase();
  if (/evening|night|recept|dinner|sunset/.test(s)) return 'evening';
  return 'morning';
};

// Statuses that do NOT consume a slot (cancelled / rejected / lost / draft).
const NON_CONSUMING = ['cancelled', 'canceled', 'rejected', 'lost', 'draft'];
export const consumesSlot = (booking) =>
  !NON_CONSUMING.includes(String(booking?.status || '').toLowerCase());
