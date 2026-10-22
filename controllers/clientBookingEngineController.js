import Booking from '../models/Booking.js';
import BlockedDate from '../models/BlockedDate.js';
import District from '../models/District.js';
import ServicePackage from '../models/Package.js';
import SlotCapacity from '../models/SlotCapacity.js';
import SlotHold from '../models/SlotHold.js';
import { slotHalf, consumesSlot, dayKey } from '../utils/slots.js';

const DEFAULT_MORNING = 3;
const DEFAULT_EVENING = 3;

// Standard travel pricing matrix for Kerala districts relative to Calicut (Kozhikode) base
const DISTRICT_TRAVEL_FEES = {
  Kozhikode: 0,
  Calicut: 0,
  Malappuram: 1500,
  Wayanad: 2000,
  Kannur: 2500,
  Palakkad: 2500,
  Thrissur: 3000,
  Ernakulam: 4000,
  Kochi: 4000,
  Kasaragod: 4500,
  Alappuzha: 5000,
  Kottayam: 5000,
  Idukki: 5500,
  Pathanamthitta: 6000,
  Kollam: 6500,
  Thiruvananthapuram: 7000,
  Trivandrum: 7000,
};

const getTravelFeeForDistrict = (districtName) => {
  if (!districtName) return 0;
  const match = Object.keys(DISTRICT_TRAVEL_FEES).find(
    (k) => k.toLowerCase() === String(districtName).trim().toLowerCase()
  );
  return match !== undefined ? DISTRICT_TRAVEL_FEES[match] : 4000; // default outstation
};

const getDefaultCapacity = async () => {
  let def = await SlotCapacity.findOne({ date: null }).lean();
  return {
    morning: def?.morning ?? DEFAULT_MORNING,
    evening: def?.evening ?? DEFAULT_EVENING,
  };
};

/**
 * Check availability for a specific date string (YYYY-MM-DD).
 */
export const checkSingleDateAvailability = async (dateStr, clientUserId = null) => {
  const day = dayKey(dateStr);
  if (Number.isNaN(day.getTime())) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD');
  }

  const def = await getDefaultCapacity();
  const override = await SlotCapacity.findOne({ date: day }).lean();
  const morningCap = override?.morning ?? def.morning;
  const eveningCap = override?.evening ?? def.evening;
  const totalCap = morningCap + eveningCap;

  const dayEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000);

  // Check if date is HR-blocked
  const isBlocked = !!(await BlockedDate.exists({
    active: true,
    date: { $gte: day, $lt: dayEnd },
  }));

  if (isBlocked) {
    return {
      date: dateStr,
      isBlocked: true,
      status: 'sold_out',
      reason: 'Auspicious date blocked by studio operations',
      morning: { capacity: morningCap, booked: morningCap, available: 0, status: 'sold_out' },
      evening: { capacity: eveningCap, booked: eveningCap, available: 0, status: 'sold_out' },
      total: { capacity: totalCap, booked: totalCap, available: 0, status: 'sold_out' },
    };
  }

  // Count existing confirmed/pending bookings
  const bookings = await Booking.find({
    bookingDate: { $gte: day, $lt: dayEnd },
    status: { $nin: ['cancelled', 'rejected', 'Cancelled', 'Rejected'] },
  })
    .select('eventSlot status')
    .lean();

  let bookedMorning = 0;
  let bookedEvening = 0;
  for (const b of bookings) {
    if (!consumesSlot(b)) continue;
    const half = slotHalf(b.eventSlot);
    if (half === 'morning') bookedMorning += 1;
    else if (half === 'evening') bookedEvening += 1;
  }

  // Count active holds (excluding caller's own hold if any)
  const holdFilter = {
    dateStr,
    status: 'active',
    expiresAt: { $gt: new Date() },
  };
  if (clientUserId) {
    holdFilter.clientUserId = { $ne: clientUserId };
  }
  const activeHolds = await SlotHold.find(holdFilter).select('slot').lean();

  let holdMorning = 0;
  let holdEvening = 0;
  for (const h of activeHolds) {
    const s = String(h.slot || '').toLowerCase();
    if (s.includes('morning')) holdMorning += 1;
    else if (s.includes('evening') || s.includes('afternoon')) holdEvening += 1;
    else if (s.includes('full')) {
      holdMorning += 1;
      holdEvening += 1;
    }
  }

  const morningAvail = Math.max(0, morningCap - bookedMorning - holdMorning);
  const eveningAvail = Math.max(0, eveningCap - bookedEvening - holdEvening);
  const totalAvail = morningAvail + eveningAvail;

  const getStatus = (avail) => {
    if (avail <= 0) return 'sold_out';
    if (avail <= 2) return 'fast_filling';
    return 'available';
  };

  return {
    date: dateStr,
    isBlocked: false,
    status: getStatus(totalAvail),
    morning: {
      capacity: morningCap,
      booked: bookedMorning + holdMorning,
      available: morningAvail,
      status: getStatus(morningAvail),
    },
    evening: {
      capacity: eveningCap,
      booked: bookedEvening + holdEvening,
      available: eveningAvail,
      status: getStatus(eveningAvail),
    },
    total: {
      capacity: totalCap,
      booked: bookedMorning + bookedEvening + holdMorning + holdEvening,
      available: totalAvail,
      status: getStatus(totalAvail),
    },
  };
};

// @route GET /api/client/availability?date=YYYY-MM-DD or ?dates=YYYY-MM-DD,YYYY-MM-DD
export const getAvailability = async (req, res) => {
  try {
    const { date, dates } = req.query;
    const clientUserId = req.client?._id;

    if (dates) {
      const dateList = String(dates)
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      const results = await Promise.all(
        dateList.map((d) => checkSingleDateAvailability(d, clientUserId))
      );
      return res.json(results);
    }

    if (date) {
      const result = await checkSingleDateAvailability(String(date).trim(), clientUserId);
      return res.json(result);
    }

    // Default to next 14 days if nothing passed
    const now = new Date();
    const nextDates = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      nextDates.push(d.toISOString().slice(0, 10));
    }
    const results = await Promise.all(
      nextDates.map((d) => checkSingleDateAvailability(d, clientUserId))
    );
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/client/bookings/hold
// 10-Minute Atomic Slot Hold to lock capacity during checkout
export const holdSlot = async (req, res) => {
  try {
    const { date, slot, packageId } = req.body;
    if (!date) {
      return res.status(400).json({ message: 'Date is required (YYYY-MM-DD)' });
    }
    const slotNormalized = String(slot || 'Morning').trim();
    const dateStr = String(date).slice(0, 10);
    const clientUserId = req.client._id;

    // Check availability
    const avail = await checkSingleDateAvailability(dateStr, clientUserId);
    if (avail.isBlocked) {
      return res.status(409).json({ message: 'This date is blocked and cannot be reserved.' });
    }

    const half = slotHalf(slotNormalized);
    const targetAvail = half === 'morning' ? avail.morning.available : avail.evening.available;
    if (targetAvail <= 0 && avail.total.available <= 0) {
      return res.status(409).json({
        message: 'This time slot was just booked by another bride. Please select another slot or date.',
      });
    }

    // Release any previous active hold by this client on other slots
    await SlotHold.updateMany(
      { clientUserId, status: 'active' },
      { $set: { status: 'released' } }
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    const hold = await SlotHold.create({
      date: dayKey(dateStr),
      dateStr,
      slot: slotNormalized,
      clientUserId,
      packageId: packageId || null,
      expiresAt,
      status: 'active',
    });

    res.status(201).json({
      holdId: String(hold._id),
      date: dateStr,
      slot: slotNormalized,
      expiresAt: hold.expiresAt,
      remainingSeconds: 600,
      message: 'Slot atomically held for 10 minutes. Please complete your booking to lock your date.',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/client/bookings/hold/:id
export const releaseSlotHold = async (req, res) => {
  try {
    const { id } = req.params;
    await SlotHold.updateOne(
      { _id: id, clientUserId: req.client._id },
      { $set: { status: 'released' } }
    );
    res.json({ released: true, message: 'Slot hold released' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/client/districts
export const getDistrictsAndTravel = async (req, res) => {
  try {
    const dbDistricts = await District.find({ status: 'active' })
      .populate('region', 'name')
      .sort({ name: 1 })
      .lean();

    const districts = Object.keys(DISTRICT_TRAVEL_FEES).map((name) => {
      const match = dbDistricts.find(
        (d) => d.name.toLowerCase() === name.toLowerCase()
      );
      return {
        id: match ? String(match._id) : name.toLowerCase(),
        name,
        travelFee: DISTRICT_TRAVEL_FEES[name],
        isBaseStudio: DISTRICT_TRAVEL_FEES[name] === 0,
        region: match?.region?.name || 'Kerala',
      };
    });

    res.json(districts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/client/estimate
// Real-time calculation of package price, tier multiplier, district travel, early call fee, and entourage
export const calculateEstimate = async (req, res) => {
  try {
    const {
      packageId,
      tier = 'Standard',
      district = 'Kozhikode',
      callTime = '06:00 AM',
      entourage = {},
      dates = [],
    } = req.body;

    let basePackagePrice = 25000;
    let packageName = 'Bridal Makeover';

    if (packageId) {
      const pkg = await ServicePackage.findById(packageId).lean();
      if (pkg) {
        basePackagePrice = Number(pkg.price) || basePackagePrice;
        packageName = pkg.name;
      }
    }

    // Artist Tier multiplier: Standard (1.0x), Premium (1.3x), Signature (1.6x)
    let tierMultiplier = 1.0;
    const tierLower = String(tier).toLowerCase();
    if (tierLower.includes('premium')) tierMultiplier = 1.3;
    else if (tierLower.includes('signature') || tierLower.includes('lead')) tierMultiplier = 1.6;

    const tierAdjustedPrice = Math.round(basePackagePrice * tierMultiplier);

    // District Travel Fee
    const travelFee = getTravelFeeForDistrict(district);

    // Early morning call surcharge (e.g. 03:00 AM - 05:00 AM)
    let earlyCallFee = 0;
    const timeClean = String(callTime).toUpperCase();
    if (
      timeClean.includes('3:') ||
      timeClean.includes('03:') ||
      timeClean.includes('4:') ||
      timeClean.includes('04:') ||
      timeClean.includes('EARLY')
    ) {
      earlyCallFee = 2000;
    }

    // Entourage Breakdown
    const motherCount = Math.max(0, Number(entourage.motherCount) || 0);
    const sisterCount = Math.max(0, Number(entourage.sisterCount) || 0);
    const drapingCount = Math.max(0, Number(entourage.drapingCount) || 0);

    const motherRate = 4500;
    const sisterRate = 3500;
    const drapingRate = 1500;

    const motherTotal = motherCount * motherRate;
    const sisterTotal = sisterCount * sisterRate;
    const drapingTotal = drapingCount * drapingRate;
    const entourageTotal = motherTotal + sisterTotal + drapingTotal;

    // Extra dates charge
    const dateCount = Math.max(1, Array.isArray(dates) ? dates.length : 1);
    const extraDateCharge = (dateCount - 1) * 10000;

    const subtotal = tierAdjustedPrice + travelFee + earlyCallFee + entourageTotal + extraDateCharge;
    const gstRate = 0.18;
    const gstAmount = Math.round(subtotal * gstRate);
    const totalAmount = subtotal + gstAmount;

    // Advance deposit (20% of total, rounded to nearest 500)
    const advanceAmount = Math.max(5000, Math.round((totalAmount * 0.2) / 500) * 500);

    res.json({
      packageName,
      basePackagePrice,
      tier,
      tierMultiplier,
      tierAdjustedPrice,
      district,
      travelFee,
      earlyCallFee,
      entourage: {
        motherCount,
        motherRate,
        motherTotal,
        sisterCount,
        sisterRate,
        sisterTotal,
        drapingCount,
        drapingRate,
        drapingTotal,
        entourageTotal,
      },
      dateCount,
      extraDateCharge,
      subtotal,
      gstRate,
      gstAmount,
      totalAmount,
      advanceAmount,
      balanceDue: totalAmount - advanceAmount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
