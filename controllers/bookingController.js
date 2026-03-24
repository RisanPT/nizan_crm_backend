import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import {
  sendAdvanceInvoiceEmail,
  sendCompletionInvoiceEmail,
} from '../utils/bookingInvoiceEmail.js';

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
    requiredRoomDetail,
    secondaryContact,
    outfitDetails,
    captureStaffDetails,
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
  } = req.body;

  try {
    const normalizedEmail = String(email ?? '').trim();
    if (!normalizedEmail || isPlaceholderEmail(normalizedEmail)) {
      return res.status(400).json({ message: 'Client email is required' });
    }

    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDriverId = normalizeObjectId(driverId);
    const normalizedAssignedStaff = normalizeAssignedStaff(assignedStaff);
    const normalizedAddons = normalizeAddons(addons);

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
      packageId: normalizedPackageId,
      regionId: normalizedRegionId,
      driverId: normalizedDriverId,
      customerName,
      email: normalizedEmail,
      phone,
      service,
      region,
      driverName,
      status,
      mapUrl,
      travelMode,
      travelTime,
      travelDistanceKm,
      requiredRoomDetail,
      secondaryContact,
      outfitDetails,
      captureStaffDetails,
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
      assignedStaff: normalizedAssignedStaff,
      addons: normalizedAddons,
    });

    res.status(201).json(booking);
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
      requiredRoomDetail,
      secondaryContact,
      outfitDetails,
      captureStaffDetails,
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
    } = req.body;

    const previousStatus = String(booking.status ?? '').toLowerCase();
    const normalizedPackageId = normalizeObjectId(packageId);
    const normalizedRegionId = normalizeObjectId(regionId);
    const normalizedDriverId = normalizeObjectId(driverId);
    const normalizedAssignedStaff = normalizeAssignedStaff(assignedStaff);
    const normalizedAddons = normalizeAddons(addons);
    const nextEmail =
      email != null ? String(email).trim() : String(booking.email ?? '').trim();
    const nextStatus = String(status ?? booking.status ?? '').toLowerCase();

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
    booking.packageId =
      packageId != null ? normalizedPackageId : booking.packageId;
    booking.regionId = regionId != null ? normalizedRegionId : booking.regionId;
    booking.driverId = driverId != null ? normalizedDriverId : booking.driverId;
    booking.service = service ?? booking.service;
    booking.region = region ?? booking.region;
    booking.driverName = driverName ?? booking.driverName;
    booking.status = status ?? booking.status;
    booking.mapUrl = mapUrl ?? booking.mapUrl;
    booking.travelMode = travelMode ?? booking.travelMode;
    booking.travelTime = travelTime ?? booking.travelTime;
    booking.travelDistanceKm = travelDistanceKm ?? booking.travelDistanceKm;
    booking.requiredRoomDetail =
      requiredRoomDetail ?? booking.requiredRoomDetail;
    booking.secondaryContact = secondaryContact ?? booking.secondaryContact;
    booking.outfitDetails = outfitDetails ?? booking.outfitDetails;
    booking.captureStaffDetails =
      captureStaffDetails ?? booking.captureStaffDetails;
    booking.staffInstructions =
      staffInstructions ?? booking.staffInstructions;
    booking.internalRemarks = internalRemarks ?? booking.internalRemarks;
    booking.contentCreationRequired =
      contentCreationRequired ?? booking.contentCreationRequired;
    booking.bookingDate = bookingDate ?? booking.bookingDate;
    booking.serviceStart = serviceStart ?? booking.serviceStart;
    booking.serviceEnd = serviceEnd ?? booking.serviceEnd;
    booking.totalPrice = totalPrice ?? booking.totalPrice;
    booking.advanceAmount = advanceAmount ?? booking.advanceAmount;
    booking.discountAmount = discountAmount ?? booking.discountAmount;
    booking.discountType = discountType ?? booking.discountType;
    booking.discountValue = discountValue ?? booking.discountValue;
    booking.assignedStaff =
      assignedStaff != null ? normalizedAssignedStaff : booking.assignedStaff;
    booking.addons = addons != null ? normalizedAddons : booking.addons;

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
