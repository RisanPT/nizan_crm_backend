// Phone normalization for client identity + booking matching.
// Indian mobiles are 10 digits; numbers get entered with +91, spaces and dashes.
// We canonicalize to the LAST 10 DIGITS so "+91 70341 09552", "917034109552"
// and "7034109552" all resolve to the same client, and we match existing
// Booking/Customer rows (stored spaces-stripped, sometimes with +91) via a
// `$regex: last10 + '$'` suffix match.

export const normalizePhone = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);

/// A Mongo filter fragment that matches any stored phone ending in these 10
/// digits (regex-escaped — digits only, so safe).
export const phoneSuffixFilter = (phone) => {
  const last10 = normalizePhone(phone);
  if (last10.length < 10) return { phone: last10 };
  return { phone: { $regex: `${last10}$` } };
};

export const isValidMobile = (v) => normalizePhone(v).length === 10;
