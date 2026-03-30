import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import ServicePackage from '../models/Package.js';
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
  const hour =
    sourceDate && !Number.isNaN(sourceDate.getTime())
      ? sourceDate.getHours()
      : fallbackHour;
  const minute =
    sourceDate && !Number.isNaN(sourceDate.getTime())
      ? sourceDate.getMinutes()
      : fallbackMinute;

  return new Date(
    dateOnly.getFullYear(),
    dateOnly.getMonth(),
    dateOnly.getDate(),
    hour,
    minute,
    0,
    0
  );
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

const computeExtraDateCharge = (selectedDates = []) =>
  Math.max(0, (selectedDates?.length ?? 0) - 1) * EXTRA_DATE_AMOUNT;

const computeBasePackagePrice = async ({
  packageId,
  regionId,
  fallbackTotalPrice,
}) => {
  const normalizedFallback = Number(fallbackTotalPrice) || 0;
  if (!packageId) return normalizedFallback;

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  const matchingRegionPrice = (packageDoc.regionPrices ?? []).find(
    (item) => String(item.region) == String(regionId ?? '')
  );
  return Number(matchingRegionPrice?.price ?? packageDoc.price) || 0;
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
  fallbackTotalPrice,
  selectedDates,
}) => {
  const normalizedFallback = Number(fallbackTotalPrice) || 0;
  if (!packageId) return normalizedFallback;

  const packageDoc = await ServicePackage.findById(packageId).lean();
  if (!packageDoc) return normalizedFallback;

  const matchingRegionPrice = (packageDoc.regionPrices ?? []).find(
    (item) => String(item.region) == String(regionId ?? '')
  );
  const basePrice = Number(matchingRegionPrice?.price ?? packageDoc.price) || 0;
  const extraDatesCount = Math.max(0, (selectedDates?.length ?? 0) - 1);
  return basePrice + extraDatesCount * EXTRA_DATE_AMOUNT;
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

const normalizeBookingItems = async ({
  bookingItems = [],
  regionId,
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

export const getBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({});
    res.json(bookings);
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
    driverId,
    customerName,
    phone,
    email,
    service,
    region,
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
    assignedStaff = [],
    addons = [],
    selectedDates = [],
  } = req.body;

  try {
    const normalizedStatus = req.user
      ? 'confirmed'
      : String(status ?? 'pending').trim().toLowerCase() || 'pending';
    const normalizedEmail = String(email ?? '').trim();
    if (!normalizedEmail || isPlaceholderEmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Client email is required' });
    }

    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDriverId = normalizeObjectId(driverId);
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
    const computedTotalPrice = await computeTotalPrice({
      packageId: normalizedPackageId,
      regionId: normalizedRegionId,
      fallbackTotalPrice: totalPrice,
      selectedDates: effectiveSchedule.selectedDates,
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
          ) + computeExtraDateCharge(effectiveSchedule.selectedDates)
        : computedTotalPrice;
    const finalAdvanceAmount =
      normalizedBookingItems.length > 0
        ? normalizedBookingItems.reduce(
            (sum, item) => sum + (Number(item.advanceAmount) || 0),
            0
          )
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
        status: 'Active',
      });
    }

    const booking = await Booking.create({
      packageId: summaryPackageId,
      regionId: normalizedRegionId,
      driverId: normalizedDriverId,
      customerName,
      email: normalizedEmail,
      phone,
      service: summaryService,
      region,
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
    });

    let invoiceEmailSent = false;
    if (normalizedStatus === 'confirmed') {
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
      email,
      packageId,
      regionId,
      driverId,
      service,
      region,
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
    } = req.body;

    const previousStatus = String(booking.status ?? '').toLowerCase();
    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDriverId = normalizeObjectId(driverId);
    const normalizedAssignedStaff = normalizeAssignedStaff(assignedStaff);
    const normalizedAddons = normalizeAddons(addons);
    const schedule = resolveSchedule({
      selectedDates,
      bookingDate,
      serviceStart,
      serviceEnd,
      currentBooking: booking,
    });
    const normalizedBookingItems = await normalizeBookingItems({
      bookingItems,
      regionId:
        regionId != null ? normalizedRegionId : booking.regionId,
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
    const nextStatus = String(status ?? booking.status ?? '').toLowerCase();
    const nextPackageId =
      packageId != null ? normalizedPackageId : booking.packageId;
    const nextRegionId =
      regionId != null ? normalizedRegionId : booking.regionId;
    const computedTotalPrice = await computeTotalPrice({
      packageId: nextPackageId,
      regionId: nextRegionId,
      fallbackTotalPrice: totalPrice ?? booking.totalPrice,
      selectedDates: effectiveSchedule.selectedDates,
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
          ) + computeExtraDateCharge(effectiveSchedule.selectedDates)
        : computedTotalPrice;
    const finalAdvanceAmount =
      bookingItems != null && finalBookingItems.length > 0
        ? finalBookingItems.reduce(
            (sum, item) => sum + (Number(item.advanceAmount) || 0),
            0
          )
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
      (!nextEmail || isPlaceholderEmail(nextEmail))
    ) {
      return res.status(400).json({
        message: 'Client email is required before confirming a booking',
      });
    }

    booking.customerName = customerName ?? booking.customerName;
    booking.phone = phone ?? booking.phone;
    booking.email = nextEmail;
    booking.packageId = finalPackageId;
    booking.regionId = regionId != null ? normalizedRegionId : booking.regionId;
    booking.driverId = driverId != null ? normalizedDriverId : booking.driverId;
    booking.service = finalService;
    booking.region = region ?? booking.region;
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
        invoiceEmailSent = await sendAdvanceInvoiceEmail(updatedBooking);
      } catch (emailError) {
        console.error('Failed to send advance invoice email:', emailError);
      }
    }

    let completionInvoiceEmailSent = false;
    if (shouldSendCompletionInvoice) {
      try {
        completionInvoiceEmailSent = await sendCompletionInvoiceEmail(
          updatedBooking
        );

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
