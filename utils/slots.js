// Helpers for the day-wise (morning / evening) booking-slot capacity system.

export const HALVES = ['morning', 'evening'];

// Normalize any date to UTC midnight so a whole day groups to one key.
export const dayKey = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return x; // caller checks isNaN
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

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
