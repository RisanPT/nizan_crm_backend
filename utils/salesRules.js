import mongoose from 'mongoose';
import User from '../models/User.js';

// Which bookings count toward SALES TOTALS (revenue figures).
//
// A booking is left out of every sales total when the CRM user who ENTERED it
// has "Count in sales totals" switched off (User.countInSalesTotals = false,
// Settings → Users). The bookings still appear in lists / calendar, and
// accounts, invoices, GST, client spend and artist earnings are unaffected.
// Mirrored in the app by lib/core/config/sales_rules.dart.

const TTL_MS = 60 * 1000;
let cache = { ids: [], at: 0 };

/// Ids (strings) of users whose bookings must not count toward sales.
export const getSalesExcludedCreatorIds = async () => {
  if (Date.now() - cache.at < TTL_MS) return cache.ids;
  const users = await User.find({ countInSalesTotals: false })
    .select('_id')
    .lean();
  cache = { ids: users.map((u) => String(u._id)), at: Date.now() };
  return cache.ids;
};

/// Call after a user's countInSalesTotals changes so totals update at once.
export const invalidateSalesRules = () => {
  cache = { ids: [], at: 0 };
};

/// Mongo $match fragment keeping only bookings that count toward sales.
/// Combine with an existing filter: { $and: [filter, await salesCountMatch()] }.
export const salesCountMatch = async () => {
  const ids = await getSalesExcludedCreatorIds();
  if (ids.length === 0) return {};
  return {
    createdBy: { $nin: ids.map((id) => new mongoose.Types.ObjectId(id)) },
  };
};

/// Returns a predicate (booking) => bool for JS-side reduces. The booking must
/// carry `createdBy` (add it to any `.select(...)`).
export const makeCountsTowardSales = async () => {
  const excluded = new Set(await getSalesExcludedCreatorIds());
  return (booking) =>
    !excluded.has(String(booking?.createdBy?._id ?? booking?.createdBy ?? ''));
};

// @route GET /api/bookings/sales-excluded-creators  (auth)
// The app uses this to apply the same rule to totals it computes itself.
export const getSalesExcludedCreatorsHandler = async (req, res) => {
  try {
    res.json({ creatorIds: await getSalesExcludedCreatorIds() });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
