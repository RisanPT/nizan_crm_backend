import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import ServicePackage from '../models/Package.js';
import Lead from '../models/Lead.js';
import {
  sendAdvanceInvoiceEmail,
  sendCompletionInvoiceEmail,
} from '../utils/bookingInvoiceEmail.js';

const EXTRA_DATE_AMOUNT = 3000;

const normalizeObjectId = (value) => {
  if (value == null || value == '') return null;
  return value;
};

const isPlaceholderEmail = (value = '') =>
  String(value).trim().toLowerCase().endsWith('@placeholder.local');

const parseLegacyBookingFlag = (value) =>
  value === true || String(value ?? '').trim().toLowerCase() === 'true';

const generatePlaceholderEmail = ({ customerName = '', phone = '' }) => {
  const normalizedName = String(customerName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  const normalizedPhone = String(phone ?? '').replace(/\D+/g, '').slice(-10);
  const fallbackKey = normalizedPhone || `${Date.now()}`;
  const localPart = normalizedName
    ? `${normalizedName}.${fallbackKey}`
    : `legacy.${fallbackKey}`;

  return `${localPart}@placeholder.local`;
};

const normalizeWorks = (works, fallbackSpecialization = '') => {
  if (Array.isArray(works)) {
    return [
      ...new Set(
        works
          .map((item) => String(item ?? '').trim())
          .filter(Boolean)
      ),
    ];
  }

  const normalizedFallback = String(fallbackSpecialization ?? '').trim();
  return normalizedFallback ? [normalizedFallback] : [];
};

const normalizeAssignedStaff = (assignedStaff = []) => {
  if (!Array.isArray(assignedStaff)) return [];

  return assignedStaff
    .filter((item) => item && item.employeeId)
    .map((item) => {
      const normalizedWorks = normalizeWorks(
        item.works,
        item.specialization ?? item.role
      );
      const normalizedSpecialization =
        String(item.specialization ?? '').trim() ||
        normalizedWorks[0] ||
        String(item.role ?? '').trim();

      return {
        employeeId: item.employeeId,
        artistName: item.artistName ?? '',
        role: item.role ?? normalizedSpecialization,
        specialization: normalizedSpecialization,
        works: normalizedWorks,
        phone: item.phone ?? '',
        type: item.type ?? '',
        roleType: item.roleType ?? 'assistant',
      };
    });
};

const normalizeAddons = (addons = []) => {
  if (!Array.isArray(addons)) return [];

  return addons
    .filter((item) => item && item.service)
    .map((item) => ({
      addonServiceId: normalizeObjectId(item.addonServiceId),
      service: item.service ?? '',
      amount: Number(item.amount) || 0,
      persons: Math.max(1, Number(item.persons) || 1),
    }));
};

const computeAddonsTotal = (addons = []) =>
  (Array.isArray(addons) ? addons : []).reduce(
    (sum, addon) =>
      sum + ((Number(addon?.amount) || 0) * Math.max(1, Number(addon?.persons) || 1)),
    0
  );

const formatDateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

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
    return [
      `${parsedFallback.getFullYear()}-${String(parsedFallback.getMonth() + 1).padStart(2, '0')}-${String(parsedFallback.getDate()).padStart(2, '0')}`,
    ];
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

const summarizeServices = (bookingItems = [], fallbackService = '') => {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return String(fallbackService ?? '').trim();
  }

  const services = [
    ...new Set(
      bookingItems
        .map((item) => String(item.service ?? '').trim())
        .filter(Boolean)
    ),
  ];

  return services.join(' + ');
};

const summarizeEventSlots = (bookingItems = [], fallbackSlot = '') => {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return String(fallbackSlot ?? '').trim();
  }

  const slots = [
    ...new Set(
      bookingItems
        .map((item) => String(item.eventSlot ?? '').trim())
        .filter(Boolean)
    ),
  ];

  return slots.join(' | ');
};

const summarizeAssignedStaff = (bookingItems = [], fallbackAssignedStaff = []) => {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return normalizeAssignedStaff(fallbackAssignedStaff);
  }

  const mergedAssignments = [];
  const seen = new Set();

  for (const item of bookingItems) {
    for (const assignment of normalizeAssignedStaff(item?.assignedStaff ?? [])) {
      const key =
        String(assignment.employeeId ?? '').trim() ||
        `${String(assignment.artistName ?? '').trim()}::${String(assignment.roleType ?? '').trim()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      mergedAssignments.push(assignment);
    }
  }

  return mergedAssignments;
};

const mergeBookingItemDates = (bookingItems = [], fallbackDates = []) => {
  const itemDates = bookingItems.flatMap((item) => item.selectedDates ?? []);
  const sourceDates = itemDates.length > 0 ? itemDates : fallbackDates;
  return normalizeSelectedDates(sourceDates);
};

const computeExtraDateCharge = ({
  selectedDates = [],
  packageCount = 1,
}) =>
  Math.max(0, (selectedDates?.length ?? 0) - 1) *
  EXTRA_DATE_AMOUNT *
  Math.max(1, Number(packageCount) || 1);

// Per-day charge derived per item from ITS OWN dates. EXTRA_DATE_AMOUNT is
// billed for EVERY day a package runs (not only additional days), so one date
// of a 21500 package totals 24500 and two dates total 49000.
const computeItemsExtraDateCharge = (bookingItems = []) =>
  (Array.isArray(bookingItems) ? bookingItems : []).reduce(
    (sum, item) =>
      sum + Math.max(1, item?.selectedDates?.length ?? 1) * EXTRA_DATE_AMOUNT,
    0
  );

const computeBasePackagePrice = async ({
  packageId,
  regionId,
  districtId,
  fallbackTotalPrice,
}) => {
  const normalizedFallback = Number(fallbackTotalPrice) || 0;
  if (!packageId) return normalizedFallback;

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  if (districtId) {
    const matchingDistrictPrice = (packageDoc.districtPrices ?? []).find(
      (item) => String(item.district) == String(districtId)
    );
    if (matchingDistrictPrice) {
      return Number(matchingDistrictPrice.price) || 0;
    }
  }

  if (regionId) {
    const matchingRegionPrice = (packageDoc.regionPrices ?? []).find(
      (item) => String(item.region) == String(regionId)
    );
    if (matchingRegionPrice) {
      return Number(matchingRegionPrice.price) || 0;
    }
  }

  return Number(packageDoc.price) || 0;
};

const computeBaseAdvanceAmount = async ({
  packageId,
  fallbackAdvanceAmount,
}) => {
  const normalizedFallback = Number(fallbackAdvanceAmount) || 0;
  if (!packageId) return normalizedFallback;

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  return Number(packageDoc.advanceAmount) || normalizedFallback;
};

const computeTotalPrice = async ({
  packageId,
  regionId,
  districtId,
  fallbackTotalPrice,
  selectedDates,
  addonsTotal = 0,
}) => {
  const normalizedFallback = Number(fallbackTotalPrice) || 0;
  if (!packageId) {
    const basePrice = normalizedFallback - addonsTotal;
    return basePrice < 0 ? 0 : basePrice;
  }

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  let basePrice = Number(packageDoc.price) || 0;

  if (districtId) {
    const matchingDistrictPrice = (packageDoc.districtPrices ?? []).find(
      (item) => String(item.district) == String(districtId)
    );
    if (matchingDistrictPrice) {
      basePrice = Number(matchingDistrictPrice.price) || 0;
    } else if (regionId) {
      const matchingRegionPrice = (packageDoc.regionPrices ?? []).find(
        (item) => String(item.region) == String(regionId)
      );
      if (matchingRegionPrice) {
        basePrice = Number(matchingRegionPrice.price) || 0;
      }
    }
  } else if (regionId) {
    const matchingRegionPrice = (packageDoc.regionPrices ?? []).find(
      (item) => String(item.region) == String(regionId)
    );
    if (matchingRegionPrice) {
      basePrice = Number(matchingRegionPrice.price) || 0;
    }
  }

  return (
    basePrice +
    computeExtraDateCharge({
      selectedDates,
      packageCount: 1,
    })
  );
};

const computeAdvanceAmount = async ({
  packageId,
  fallbackAdvanceAmount,
  selectedDates,
}) => {
  const normalizedFallback = Number(fallbackAdvanceAmount) || 0;
  if (!packageId) return normalizedFallback;

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  const baseAdvance = Number(packageDoc.advanceAmount) || normalizedFallback;
  const dateCount = Math.max(1, selectedDates?.length ?? 0);
  return baseAdvance * dateCount;
};

// Advance is charged per item per day it actually runs. Using each item's own
// dates keeps "one package per date" correct (2 dates x 3000 = 6000) instead of
// multiplying the whole basket by the merged date count.
// Equivalent to the old formula when every item shares the same dates.
const computeBookingItemsAdvanceAmount = ({
  bookingItems = [],
  selectedDates = [],
}) => {
  const fallbackDateCount = Math.max(1, selectedDates?.length ?? 0);
  return bookingItems.reduce((sum, item) => {
    const itemDateCount = Math.max(
      1,
      item?.selectedDates?.length ?? fallbackDateCount
    );
    return sum + (Number(item?.advanceAmount) || 0) * itemDateCount;
  }, 0);
};

const normalizeBookingItems = async ({
  bookingItems = [],
  regionId,
  districtId,
  fallbackSelectedDates = [],
  fallbackBookingDate = null,
}) => {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return [];
  }

  const normalizedItems = [];

  for (const item of bookingItems) {
    const normalizedPackageId = normalizeObjectId(item?.packageId);
    const itemSchedule = resolveSchedule({
      selectedDates: item?.selectedDates ?? fallbackSelectedDates,
      bookingDate: fallbackBookingDate,
    });
    const computedTotalPrice = await computeBasePackagePrice({
      packageId: normalizedPackageId,
      regionId,
      districtId,
      fallbackTotalPrice: item?.totalPrice,
    });
    const computedAdvanceAmount = await computeBaseAdvanceAmount({
      packageId: normalizedPackageId,
      fallbackAdvanceAmount: item?.advanceAmount ?? 3000,
    });

    let packageDoc = null;
    if (normalizedPackageId) {
      packageDoc = await ServicePackage.findById(normalizedPackageId).lean();
    }

    const normalizedService =
      String(item?.service ?? '').trim() || packageDoc?.name || 'Package';

    normalizedItems.push({
      packageId: normalizedPackageId,
      service: normalizedService,
      eventSlot: String(item?.eventSlot ?? '').trim(),
      selectedDates: itemSchedule.selectedDates,
      totalPrice: computedTotalPrice,
      advanceAmount: computedAdvanceAmount,
      assignedStaff: normalizeAssignedStaff(item?.assignedStaff ?? []),
    });
  }

  return normalizedItems;
};


// ── Lead → Booking linkage ──────────────────────────────────────────────────
// Indian numbers get entered inconsistently (+91, 0-prefix, spaces, dashes),
// so match on the last 10 digits only.
const phoneKey = (value = '') => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/// Marks the matching lead(s) as Converted once a booking exists for the same
/// mobile number, and links them to that booking. Never throws — a failure
/// here must not fail the booking itself.
const linkLeadsToBooking = async (booking) => {
  try {
    const key = phoneKey(booking?.phone);
    if (key.length < 10) return;

    // Match on the last 10 digits regardless of how the lead was stored.
    const candidates = await Lead.find({
      phone: { $regex: `${key}$` },
    });

    for (const lead of candidates) {
      if (phoneKey(lead.phone) !== key) continue;
      // Don't overwrite a lead already tied to another booking.
      if (lead.bookingId && String(lead.bookingId) !== String(booking._id)) {
        continue;
      }
      lead.status = 'Converted';
      lead.bookingId = booking._id;
      lead.bookedDate = lead.bookedDate ?? booking.bookingDate ?? new Date();
      // Carry the confirmed address/geography onto the lead so lead reports
      // can be grouped by district, region and pincode.
      lead.address = booking.address || lead.address;
      lead.pincode = booking.pincode || lead.pincode;
      lead.regionId = booking.regionId || lead.regionId;
      lead.districtId = booking.districtId || lead.districtId;
      lead.region = booking.region || lead.region;
      lead.district = booking.district || lead.district;
      await lead.save();
    }
  } catch (error) {
    console.error('Failed to link leads to booking:', error);
  }
};

const escapeRegex = (value = '') =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildBookingSearchMatch = (search = '') => {
  const normalizedSearch = String(search ?? '').trim();
  if (!normalizedSearch) return {};

  // For multi-word support, we split the search query into terms
  const terms = normalizedSearch.split(/\s+/).filter(Boolean);

  const andConditions = terms.map((term) => {
    const bookingNumTerm = term.startsWith('#') ? term.slice(1) : term;
    const phoneCleanTerm = term.replace(/\D/g, '');

    const regex = new RegExp(escapeRegex(term), 'i');
    const bookingRegex = new RegExp(escapeRegex(bookingNumTerm), 'i');

    const orConditions = [
      { customerName: regex },
      { email: regex },
      { service: regex },
      { region: regex },
      { bookingNumber: bookingRegex },
      { internalRemarks: regex },
    ];

    if (phoneCleanTerm.length > 0) {
      orConditions.push({ phone: new RegExp(escapeRegex(phoneCleanTerm), 'i') });
    }

    // Handle exact MongoDB ID search for individual terms if they match
    if (/^[a-fA-F0-9]{24}$/.test(term)) {
      orConditions.push({ _id: term });
    }

    return { $or: orConditions };
  });

  return andConditions.length > 0 ? { $and: andConditions } : {};
};

const buildDuplicateGroupsPipeline = (match = {}) => [
  { $match: match },
  {
    $project: {
      _id: 1,
      customerKey: {
        $toLower: {
          $trim: { input: { $ifNull: ['$customerName', ''] } },
        },
      },
      phoneKey: {
        $trim: { input: { $ifNull: ['$phone', ''] } },
      },
      emailKey: {
        $toLower: {
          $trim: { input: { $ifNull: ['$email', ''] } },
        },
      },
      dateKey: {
        $dateToString: {
          date: '$bookingDate',
          format: '%Y-%m-%d',
          timezone: 'Asia/Kolkata',
        },
      },
    },
  },
  {
    $addFields: {
      contactKey: {
        $cond: [
          { $gt: [{ $strLenCP: '$phoneKey' }, 0] },
          '$phoneKey',
          '$emailKey',
        ],
      },
    },
  },
  {
    $match: {
      customerKey: { $ne: '' },
      contactKey: { $ne: '' },
      dateKey: { $ne: '' },
    },
  },
  {
    $group: {
      _id: {
        customerKey: '$customerKey',
        contactKey: '$contactKey',
        dateKey: '$dateKey',
      },
      ids: { $push: '$_id' },
      count: { $sum: 1 },
    },
  },
  { $match: { count: { $gt: 1 } } },
];

const buildBookingSortPipeline = (search = '') => {
  const normalizedSearch = String(search ?? '').trim();
  if (!normalizedSearch) {
    return [{ $sort: { createdAt: -1, bookingDate: -1 } }];
  }

  const loweredSearch = normalizedSearch.toLowerCase();
  const bookingNumberSearch = loweredSearch.startsWith('#')
    ? loweredSearch.slice(1)
    : loweredSearch;
  const phoneSearch = normalizedSearch.replace(/\D/g, '');
  const exactRegex = new RegExp(`^${escapeRegex(normalizedSearch)}$`, 'i');
  const prefixRegex = new RegExp(`^${escapeRegex(normalizedSearch)}`, 'i');
  const containsRegex = new RegExp(escapeRegex(normalizedSearch), 'i');
  const bookingExactRegex = new RegExp(`^${escapeRegex(bookingNumberSearch)}$`, 'i');
  const bookingPrefixRegex = new RegExp(`^${escapeRegex(bookingNumberSearch)}`, 'i');
  const phoneExactRegex = phoneSearch
    ? new RegExp(`^${escapeRegex(phoneSearch)}$`, 'i')
    : null;
  const phoneContainsRegex = phoneSearch
    ? new RegExp(escapeRegex(phoneSearch), 'i')
    : null;

  return [
    {
      $addFields: {
        searchRank: {
          $add: [
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$customerName', ''] }, regex: exactRegex } },
                120,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$bookingNumber', ''] }, regex: bookingExactRegex } },
                115,
                0,
              ],
            },
            {
              $cond: [
                phoneExactRegex == null
                  ? false
                  : { $regexMatch: { input: { $ifNull: ['$phone', ''] }, regex: phoneExactRegex } },
                110,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$customerName', ''] }, regex: prefixRegex } },
                80,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$bookingNumber', ''] }, regex: bookingPrefixRegex } },
                75,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$service', ''] }, regex: prefixRegex } },
                55,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$region', ''] }, regex: prefixRegex } },
                45,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$customerName', ''] }, regex: containsRegex } },
                25,
                0,
              ],
            },
            {
              $cond: [
                phoneContainsRegex == null
                  ? false
                  : { $regexMatch: { input: { $ifNull: ['$phone', ''] }, regex: phoneContainsRegex } },
                25,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$service', ''] }, regex: containsRegex } },
                15,
                0,
              ],
            },
            {
              $cond: [
                { $regexMatch: { input: { $ifNull: ['$region', ''] }, regex: containsRegex } },
                10,
                0,
              ],
            },
          ],
        },
      },
    },
    { $sort: { searchRank: -1, createdAt: -1, bookingDate: -1 } },
  ];
};

export const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({}).sort({ createdAt: -1 });
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getBookingById = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPaginatedBookings = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 20)
    );
    const skip = (page - 1) * limit;
    const search = String(req.query.search ?? '').trim();
    const duplicatesOnly =
      String(req.query.duplicatesOnly ?? '').trim().toLowerCase() === 'true';
    const employeeId = String(req.query.employeeId ?? '').trim();
    const financialYear = String(req.query.financialYear ?? '').trim();
    const dateBasis = String(req.query.dateBasis ?? 'event_date').trim().toLowerCase();

    const baseMatch = buildBookingSearchMatch(search);

    // Enforce Employee/Artist filter for artist role, or use provided filter for other roles
    const isArtist = req.user.role === 'artist';
    const isDriver = req.user.role === 'driver';
    
    const effectiveEmployeeId = (isArtist || isDriver)
      ? (req.user.employeeId?.toString() || employeeId)
      : employeeId;

    if (effectiveEmployeeId && mongoose.Types.ObjectId.isValid(effectiveEmployeeId)) {
      const empId = new mongoose.Types.ObjectId(effectiveEmployeeId);
      if (isDriver) {
        baseMatch.driverId = empId;
      } else {
        baseMatch.$or = [
          { 'assignedStaff.employeeId': empId },
          { 'bookingItems.assignedStaff.employeeId': empId },
        ];
      }
    }

    // Apply Financial Year filter if provided (Format: "2024-25")
    if (financialYear && /^\d{4}-\d{2}$/.test(financialYear)) {
      const parts = financialYear.split('-');
      const startYear = Number.parseInt(parts[0], 10);
      const endYear = 2000 + Number.parseInt(parts[1], 10);

      // Financial year in India: April 1st to March 31st
      const fyStart = new Date(startYear, 3, 1, 0, 0, 0); // April 1st
      const fyEnd = new Date(endYear, 2, 31, 23, 59, 59); // March 31st

      const dateField = dateBasis === 'booking_date' ? 'createdAt' : 'bookingDate';

      baseMatch[dateField] = {
        $gte: fyStart,
        $lte: fyEnd,
      };
    }

    // Apply Month filter if provided (Format: "YYYY-MM")
    const month = String(req.query.month ?? '').trim();
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const parts = month.split('-');
      const year = Number.parseInt(parts[0], 10);
      const monthIndex = Number.parseInt(parts[1], 10) - 1;

      const startOfMonth = new Date(year, monthIndex, 1, 0, 0, 0);
      const endOfMonth = new Date(year, monthIndex + 1, 0, 23, 59, 59);

      const dateField = dateBasis === 'booking_date' ? 'createdAt' : 'bookingDate';

      baseMatch[dateField] = {
        $gte: startOfMonth,
        $lte: endOfMonth,
      };
    }

    // Apply Map Link filter if provided
    const onlyWithMapLink = String(req.query.onlyWithMapLink ?? '').trim().toLowerCase() === 'true';
    if (onlyWithMapLink) {
      baseMatch.mapUrl = { $ne: null, $not: /^\s*$/ };
    }

    // Apply Status filter if provided (Format: "completed" or "upcoming")
    const status = String(req.query.status ?? '').trim().toLowerCase();
    if (status) {
      if (status === 'completed') {
        baseMatch.status = { $regex: /^completed$/i };
      } else if (status === 'upcoming') {
        baseMatch.status = { $nin: ['completed', 'cancelled', 'rejected', 'Completed', 'Cancelled', 'Rejected'] };
      }
    }

    // Geographic filtering logic
    const zoneId = String(req.query.zoneId ?? '').trim();
    const stateId = String(req.query.stateId ?? '').trim();
    const regionId = String(req.query.regionId ?? '').trim();
    const districtId = String(req.query.districtId ?? '').trim();

    if (districtId && mongoose.Types.ObjectId.isValid(districtId)) {
      baseMatch.districtId = new mongoose.Types.ObjectId(districtId);
    } else if (regionId && mongoose.Types.ObjectId.isValid(regionId)) {
      baseMatch.regionId = new mongoose.Types.ObjectId(regionId);
    } else if (stateId && mongoose.Types.ObjectId.isValid(stateId)) {
      const mongoose = await import('mongoose');
      const RegionModel = mongoose.model('Region');
      const regions = await RegionModel.find({ state: stateId }).select('_id').lean();
      baseMatch.regionId = { $in: regions.map(r => r._id) };
    } else if (zoneId && mongoose.Types.ObjectId.isValid(zoneId)) {
      const mongoose = await import('mongoose');
      const StateModel = mongoose.model('State');
      const RegionModel = mongoose.model('Region');
      const states = await StateModel.find({ zone: zoneId }).select('_id').lean();
      const regions = await RegionModel.find({ state: { $in: states.map(s => s._id) } }).select('_id').lean();
      baseMatch.regionId = { $in: regions.map(r => r._id) };
    }

    const duplicateGroups = await Booking.aggregate(
      buildDuplicateGroupsPipeline(baseMatch)
    );
    const duplicateCountById = new Map();
    const duplicateIds = [];

    for (const group of duplicateGroups) {
      for (const id of group.ids ?? []) {
        duplicateIds.push(id);
        duplicateCountById.set(String(id), Number(group.count) || 0);
      }
    }

    const query = duplicatesOnly ? { _id: { $in: duplicateIds } } : baseMatch;

    const [items, totalItems, summaryResult] = await Promise.all([
      Booking.aggregate([
        { $match: query },
        ...buildBookingSortPipeline(search),
        { $skip: skip },
        { $limit: limit },
      ]),
      duplicatesOnly
        ? Promise.resolve(duplicateIds.length)
        : Booking.countDocuments(baseMatch),
      Booking.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalSales: { $sum: { $ifNull: ['$totalPrice', 0] } },
            totalAdvance: { $sum: { $ifNull: ['$advanceAmount', 0] } },
            completedCount: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $toLower: { $ifNull: ['$status', ''] } },
                      'completed',
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            cancelledCount: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      { $toLower: { $ifNull: ['$status', ''] } },
                      'cancelled',
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);

    const summary = summaryResult[0] ?? {
      totalSales: 0,
      totalAdvance: 0,
      completedCount: 0,
      cancelledCount: 0,
    };
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const enrichedItems = items.map((item) => ({
      ...item,
      duplicateCount: duplicateCountById.get(String(item._id)) || 0,
    }));

    res.json({
      items: enrichedItems,
      page,
      limit,
      totalItems,
      totalPages,
      duplicateItems: duplicateIds.length,
      duplicateGroups: duplicateGroups.length,
      summary: {
        totalSales: Number(summary.totalSales) || 0,
        totalAdvance: Number(summary.totalAdvance) || 0,
        completedCount: Number(summary.completedCount) || 0,
        cancelledCount: Number(summary.cancelledCount) || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPublicBookings = async (req, res) => {
  try {
    const bookings = await Booking.find(
      {},
      {
        _id: 1,
        bookingDate: 1,
        selectedDates: 1,
        serviceStart: 1,
        serviceEnd: 1,
        status: 1,
      }
    );
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createBooking = async (req, res) => {
  const {
    bookingItems = [],
    packageId,
    regionId,
    districtId,
    driverId,
    vehicleId,
    customerName,
    phone,
    address,
    pincode,
    email,
    legacyBooking,
    service,
    region,
    district,
    driverName,
    status,
    mapUrl,
    travelMode,
    travelTime,
    travelDistanceKm,
    eventSlot,
    requiredRoomDetail,
    secondaryContact,
    outfitDetails,
    looks,
    captureStaffDetails,
    temporaryStaffDetails,
    staffInstructions,
    internalRemarks,
    contentCreationRequired,
    bookingDate,
    serviceStart,
    serviceEnd,
    totalPrice,
    advanceAmount,
    discountAmount,
    discountType,
    discountValue,
    assignedStaff = [],
    addons = [],
    selectedDates = [],
    pocId,
    pocName,
    pocPhone,
  } = req.body;

  try {
    const normalizedStatus = req.user
      ? 'confirmed'
      : String(status ?? 'pending').trim().toLowerCase() || 'pending';
    const requestedEmail = String(email ?? '').trim();
    const isLegacyBooking = Boolean(req.user) && parseLegacyBookingFlag(legacyBooking);
    const normalizedEmail =
      requestedEmail ||
      (isLegacyBooking
        ? generatePlaceholderEmail({ customerName, phone })
        : '');

    if (
      (!req.user || !isLegacyBooking) &&
      (!normalizedEmail || isPlaceholderEmail(normalizedEmail))
    ) {
      return res.status(400).json({ message: 'Client email is required' });
    }

    if (
      (!req.user || !isLegacyBooking) &&
      (!phone || !String(phone).trim())
    ) {
      return res.status(400).json({ message: 'Client phone number is required' });
    }

    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDistrictId = normalizeObjectId(districtId);
    const normalizedDriverId = normalizeObjectId(driverId);
    const normalizedVehicleId = normalizeObjectId(vehicleId);
    const normalizedAssignedStaff = normalizeAssignedStaff(assignedStaff);
    const normalizedAddons = normalizeAddons(addons);
    const schedule = resolveSchedule({
      selectedDates,
      bookingDate,
      serviceStart,
      serviceEnd,
    });
    const normalizedBookingItems = await normalizeBookingItems({
      bookingItems,
      regionId: normalizedRegionId,
      districtId: normalizedDistrictId,
      fallbackSelectedDates: schedule.selectedDates,
      fallbackBookingDate: schedule.bookingDateValue,
    });
    const effectiveSelectedDates = mergeBookingItemDates(
      normalizedBookingItems,
      schedule.selectedDates
    );
    const effectiveSchedule = normalizedBookingItems.length > 0
      ? resolveSchedule({
          selectedDates: effectiveSelectedDates,
          bookingDate: schedule.bookingDateValue,
          serviceStart,
          serviceEnd,
        })
      : schedule;
    const addonsTotal = computeAddonsTotal(normalizedAddons);
    const computedTotalPrice = await computeTotalPrice({
      packageId: normalizedPackageId,
      regionId: normalizedRegionId,
      districtId: normalizedDistrictId,
      fallbackTotalPrice: totalPrice,
      selectedDates: effectiveSchedule.selectedDates,
      addonsTotal,
    });
    const computedAdvanceAmount = await computeAdvanceAmount({
      packageId: normalizedPackageId,
      fallbackAdvanceAmount: advanceAmount,
      selectedDates: effectiveSchedule.selectedDates,
    });
    const finalTotalPrice =
      normalizedBookingItems.length > 0
        ? normalizedBookingItems.reduce(
            (sum, item) => sum + (Number(item.totalPrice) || 0),
            0
          ) +
          addonsTotal +
          computeItemsExtraDateCharge(normalizedBookingItems)
        : computedTotalPrice + addonsTotal;
    const finalAdvanceAmount =
      normalizedBookingItems.length > 0
        ? computeBookingItemsAdvanceAmount({
            bookingItems: normalizedBookingItems,
            selectedDates: effectiveSchedule.selectedDates,
          })
        : computedAdvanceAmount;
    const summaryAssignedStaff =
      normalizedBookingItems.length > 0
        ? summarizeAssignedStaff(normalizedBookingItems, normalizedAssignedStaff)
        : normalizedAssignedStaff;
    const summaryService = summarizeServices(normalizedBookingItems, service);
    const summaryEventSlot = summarizeEventSlots(normalizedBookingItems, eventSlot);
    const summaryPackageId =
      normalizedBookingItems.length > 0
        ? normalizedBookingItems[0].packageId
        : normalizedPackageId;

    // Try to find an existing customer by email OR phone
    const query = [];
    if (normalizedEmail) query.push({ email: normalizedEmail });
    if (phone) query.push({ phone });

    const customerExists = query.length > 0
      ? await Customer.findOne({ $or: query })
      : null;

    if (!customerExists) {
      await Customer.create({
        name: customerName,
        email: normalizedEmail,
        phone,
        address,
        pincode,
        status: 'Active',
      });
    }

    const booking = await Booking.create({
      packageId: summaryPackageId,
      regionId: normalizedRegionId,
      districtId: normalizedDistrictId,
      driverId: normalizedDriverId,
      vehicleId: normalizedVehicleId,
      customerName,
      email: normalizedEmail,
      legacyBooking: isLegacyBooking,
      phone,
      address,
      pincode,
      service: summaryService,
      region,
      district,
      driverName,
      status: normalizedStatus,
      mapUrl,
      travelMode,
      travelTime,
      travelDistanceKm,
      eventSlot: summaryEventSlot,
      requiredRoomDetail,
      secondaryContact,
      outfitDetails,
      captureStaffDetails,
      temporaryStaffDetails,
      staffInstructions,
      internalRemarks,
      contentCreationRequired,
      bookingDate: effectiveSchedule.bookingDateValue,
      selectedDates: effectiveSchedule.selectedDates,
      serviceStart: effectiveSchedule.serviceStartValue,
      serviceEnd: effectiveSchedule.serviceEndValue,
      totalPrice: finalTotalPrice,
      advanceAmount: finalAdvanceAmount,
      discountAmount,
      discountType,
      discountValue,
      assignedStaff: summaryAssignedStaff,
      addons: normalizedAddons,
      bookingItems: normalizedBookingItems,
      pocId: pocId ?? '',
      pocName: pocName ?? '',
      pocPhone: pocPhone ?? '',
    });

    // A booking for a known lead's number converts that lead automatically.
    await linkLeadsToBooking(booking);

    let invoiceEmailSent = false;
    if (
      normalizedStatus === 'confirmed' &&
      !isLegacyBooking &&
      !isPlaceholderEmail(normalizedEmail)
    ) {
      try {
        invoiceEmailSent = await sendAdvanceInvoiceEmail(booking);
      } catch (emailError) {
        console.error('Failed to send advance invoice email:', emailError);
      }
    }

    res.status(201).json({
      ...booking.toObject(),
      invoiceEmailSent,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const {
      bookingItems,
      customerName,
      phone,
      address,
      pincode,
      email,
      legacyBooking,
      packageId,
      regionId,
      districtId,
      driverId,
      vehicleId,
      service,
      region,
      district,
      driverName,
      status,
      mapUrl,
      travelMode,
      travelTime,
      travelDistanceKm,
      eventSlot,
      requiredRoomDetail,
      secondaryContact,
      outfitDetails,
      captureStaffDetails,
      temporaryStaffDetails,
      staffInstructions,
      internalRemarks,
      contentCreationRequired,
      bookingDate,
      serviceStart,
      serviceEnd,
      totalPrice,
      advanceAmount,
      discountAmount,
      discountType,
      discountValue,
      assignedStaff,
      addons,
      selectedDates,
      pocId,
      pocName,
      pocPhone,
    } = req.body;

    const previousStatus = String(booking.status ?? '').toLowerCase();
    console.log('[DEBUG updateBooking] req.body:', {
      travelDistanceKm: req.body.travelDistanceKm,
      travelMode: req.body.travelMode,
      travelTime: req.body.travelTime,
      keys: Object.keys(req.body)
    });
    const nextLegacyBooking =
      legacyBooking != null
        ? parseLegacyBookingFlag(legacyBooking)
        : Boolean(booking.legacyBooking);
    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDistrictId = normalizeObjectId(districtId);
    const normalizedDriverId = normalizeObjectId(driverId);
    const normalizedVehicleId = normalizeObjectId(vehicleId);
    const normalizedAssignedStaff = normalizeAssignedStaff(assignedStaff);
    const normalizedAddons = normalizeAddons(addons);
    const schedule = resolveSchedule({
      selectedDates,
      bookingDate,
      serviceStart,
      serviceEnd,
      currentBooking: booking,
    });
    const nextDistrictId =
      districtId !== undefined ? normalizedDistrictId : booking.districtId;
    const nextRegionId =
      regionId !== undefined ? normalizedRegionId : booking.regionId;
    const normalizedBookingItems = await normalizeBookingItems({
      bookingItems,
      regionId: nextRegionId,
      districtId: nextDistrictId,
      fallbackSelectedDates: schedule.selectedDates,
      fallbackBookingDate: schedule.bookingDateValue,
    });
    const effectiveSelectedDates = bookingItems != null
      ? mergeBookingItemDates(normalizedBookingItems, schedule.selectedDates)
      : schedule.selectedDates;
    const effectiveSchedule = bookingItems != null
      ? resolveSchedule({
          selectedDates: effectiveSelectedDates,
          bookingDate: schedule.bookingDateValue,
          serviceStart,
          serviceEnd,
          currentBooking: booking,
        })
      : schedule;
    const nextEmail =
      email != null ? String(email).trim() : String(booking.email ?? '').trim();
    const effectiveNextEmail =
      nextEmail ||
      (nextLegacyBooking
        ? generatePlaceholderEmail({
            customerName: customerName ?? booking.customerName,
            phone: phone ?? booking.phone,
          })
        : '');
    const nextStatus = String(status ?? booking.status ?? '').toLowerCase();
    const nextPackageId =
      packageId != null ? normalizedPackageId : booking.packageId;
    const effectiveAddons =
      addons != null ? normalizedAddons : booking.addons;
    const addonsTotal = computeAddonsTotal(effectiveAddons);
    const computedTotalPrice = await computeTotalPrice({
      packageId: nextPackageId,
      regionId: nextRegionId,
      districtId: nextDistrictId,
      fallbackTotalPrice: totalPrice ?? booking.totalPrice,
      selectedDates: effectiveSchedule.selectedDates,
      addonsTotal,
    });
    const computedAdvanceAmount = await computeAdvanceAmount({
      packageId: nextPackageId,
      fallbackAdvanceAmount: advanceAmount ?? booking.advanceAmount,
      selectedDates: effectiveSchedule.selectedDates,
    });
    const finalBookingItems =
      bookingItems != null ? normalizedBookingItems : booking.bookingItems ?? [];
    const finalTotalPrice =
      bookingItems != null && finalBookingItems.length > 0
        ? finalBookingItems.reduce(
            (sum, item) => sum + (Number(item.totalPrice) || 0),
            0
          ) +
          addonsTotal +
          computeItemsExtraDateCharge(finalBookingItems)
        : computedTotalPrice + addonsTotal;
    const finalAdvanceAmount =
      bookingItems != null && finalBookingItems.length > 0
        ? computeBookingItemsAdvanceAmount({
            bookingItems: finalBookingItems,
            selectedDates: effectiveSchedule.selectedDates,
          })
        : computedAdvanceAmount;
    const finalAssignedStaff =
      bookingItems != null && finalBookingItems.length > 0
        ? summarizeAssignedStaff(
            finalBookingItems,
            assignedStaff != null ? normalizedAssignedStaff : booking.assignedStaff,
          )
        : (assignedStaff != null ? normalizedAssignedStaff : booking.assignedStaff);
    const finalService =
      bookingItems != null
        ? summarizeServices(finalBookingItems, service ?? booking.service)
        : service ?? booking.service;
    const finalEventSlot =
      bookingItems != null
        ? summarizeEventSlots(finalBookingItems, eventSlot ?? booking.eventSlot)
        : eventSlot ?? booking.eventSlot;
    const finalPackageId =
      bookingItems != null
        ? (finalBookingItems[0]?.packageId ?? nextPackageId)
        : nextPackageId;

    if (
      nextStatus == 'confirmed' &&
      (!effectiveNextEmail ||
        (isPlaceholderEmail(effectiveNextEmail) && !nextLegacyBooking))
    ) {
      return res.status(400).json({
        message: 'Client email is required before confirming a booking',
      });
    }

    booking.customerName = customerName ?? booking.customerName;
    booking.phone = phone ?? booking.phone;
    booking.address = address ?? booking.address;
    booking.pincode = pincode ?? booking.pincode;
    booking.email = effectiveNextEmail;
    booking.legacyBooking = nextLegacyBooking;
    booking.packageId = finalPackageId;
    booking.regionId = nextRegionId;
    booking.districtId = nextDistrictId;
    booking.driverId = driverId != null ? normalizedDriverId : booking.driverId;
    booking.vehicleId = vehicleId != null ? normalizedVehicleId : booking.vehicleId;
    booking.service = finalService;
    booking.region = region ?? booking.region;
    booking.district = district ?? booking.district;
    booking.driverName = driverName ?? booking.driverName;
    booking.status = status ?? booking.status;
    booking.mapUrl = mapUrl ?? booking.mapUrl;
    booking.travelMode = travelMode ?? booking.travelMode;
    booking.travelTime = travelTime ?? booking.travelTime;
    booking.travelDistanceKm = travelDistanceKm ?? booking.travelDistanceKm;
    booking.eventSlot = finalEventSlot;
    booking.requiredRoomDetail =
      requiredRoomDetail ?? booking.requiredRoomDetail;
    booking.secondaryContact = secondaryContact ?? booking.secondaryContact;
    booking.outfitDetails = outfitDetails ?? booking.outfitDetails;
    booking.captureStaffDetails =
      captureStaffDetails ?? booking.captureStaffDetails;
    booking.temporaryStaffDetails =
      temporaryStaffDetails ?? booking.temporaryStaffDetails;
    booking.staffInstructions =
      staffInstructions ?? booking.staffInstructions;
    booking.internalRemarks = internalRemarks ?? booking.internalRemarks;
    booking.contentCreationRequired =
      contentCreationRequired ?? booking.contentCreationRequired;
    booking.bookingDate = effectiveSchedule.bookingDateValue;
    booking.selectedDates = effectiveSchedule.selectedDates;
    booking.serviceStart = effectiveSchedule.serviceStartValue;
    booking.serviceEnd = effectiveSchedule.serviceEndValue;
    booking.totalPrice = finalTotalPrice;
    booking.advanceAmount = finalAdvanceAmount;
    booking.discountAmount = discountAmount ?? booking.discountAmount;
    booking.discountType = discountType ?? booking.discountType;
    booking.discountValue = discountValue ?? booking.discountValue;
    booking.assignedStaff = finalAssignedStaff;
    booking.addons = addons != null ? normalizedAddons : booking.addons;
    booking.bookingItems = bookingItems != null ? finalBookingItems : booking.bookingItems;
    booking.pocId = pocId ?? booking.pocId;
    booking.pocName = pocName ?? booking.pocName;
    booking.pocPhone = pocPhone ?? booking.pocPhone;

    const updatedBooking = await booking.save();
    const shouldSendAdvanceInvoice =
      previousStatus != 'confirmed' &&
      String(updatedBooking.status ?? '').toLowerCase() == 'confirmed';
    const shouldSendCompletionInvoice =
      previousStatus != 'completed' &&
      String(updatedBooking.status ?? '').toLowerCase() == 'completed' &&
      !updatedBooking.completionInvoiceSentAt;

    let invoiceEmailSent = false;
    if (shouldSendAdvanceInvoice) {
      try {
        if (
          !updatedBooking.legacyBooking &&
          !isPlaceholderEmail(updatedBooking.email ?? '')
        ) {
          invoiceEmailSent = await sendAdvanceInvoiceEmail(updatedBooking);
        }
      } catch (emailError) {
        console.error('Failed to send advance invoice email:', emailError);
      }
    }

    let completionInvoiceEmailSent = false;
    if (shouldSendCompletionInvoice) {
      try {
        if (
          !updatedBooking.legacyBooking &&
          !isPlaceholderEmail(updatedBooking.email ?? '')
        ) {
          completionInvoiceEmailSent = await sendCompletionInvoiceEmail(
            updatedBooking
          );
        }

        if (completionInvoiceEmailSent) {
          updatedBooking.completionInvoiceSentAt = new Date();
          await updatedBooking.save();
        }
      } catch (emailError) {
        console.error('Failed to send completion invoice email:', emailError);
      }
    }

    res.json({
      ...updatedBooking.toObject(),
      invoiceEmailSent,
      completionInvoiceEmailSent,
    });
  } catch (error) {
    res.status(500).json({ message: error.message, details: error.stack });
  }
};

export const deleteBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (booking) {
      await booking.deleteOne();
      res.json({ message: 'Booking removed' });
    } else {
      res.status(404).json({ message: 'Booking not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
