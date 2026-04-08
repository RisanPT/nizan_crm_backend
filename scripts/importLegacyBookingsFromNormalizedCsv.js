import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import Employee from '../models/Employee.js';
import Region from '../models/Region.js';
import ServicePackage from '../models/Package.js';

dotenv.config();

const DEFAULT_BOOKINGS_CSV = path.resolve(
  process.cwd(),
  'tmp',
  'bookings_formatted_normalized.csv'
);
const DEFAULT_PACKAGE_REVIEW_CSV = path.resolve(
  process.cwd(),
  'tmp',
  'booking_package_review.csv'
);

const parseCsvLine = (line) => {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
};

const parseCsv = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? '';
      return acc;
    }, {});
  });
};

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const cleanPhone = (value) => String(value || '').replace(/[^\d+]/g, '').trim();

const titleCase = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const parseDateOnly = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const date = new Date(`${trimmed}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateOnly = (date) => date.toISOString().slice(0, 10);

const enumerateSelectedDates = (startRaw, endRaw) => {
  const start = parseDateOnly(startRaw);
  const end = parseDateOnly(endRaw);

  if (!start) return [];
  if (!end || end <= start) {
    return [formatDateOnly(start)];
  }

  const diffDays = Math.round((end.getTime() - start.getTime()) / 86400000);
  const inclusiveDays = diffDays === 1 ? 1 : diffDays + 1;

  return Array.from({ length: inclusiveDays }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return formatDateOnly(date);
  });
};

const parseTimeToken = (value) => {
  const trimmed = String(value || '').trim().toUpperCase();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/\./g, ':')
    .replace(/\s+/g, '')
    .replace('A M', 'AM')
    .replace('P M', 'PM');

  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridian = match[3] || '';

  if (meridian === 'AM') {
    if (hours === 12) hours = 0;
  } else if (meridian === 'PM') {
    if (hours < 12) hours += 12;
  }

  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
};

const combineDateAndTime = (date, timeToken, fallbackHour = 9) => {
  const result = new Date(date);
  result.setHours(
    timeToken?.hours ?? fallbackHour,
    timeToken?.minutes ?? 0,
    0,
    0
  );
  return result;
};

const mapLegacyStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'postponed') return 'cancelled';
  if (normalized === 'completed') return 'completed';
  return 'confirmed';
};

const extractCustomerName = (row, rowIndex) => {
  const direct = String(row.customer_name || '').trim();
  if (direct) return titleCase(direct);

  const title = String(row.booking_title || '').trim();
  if (title && !/^b\d+$/i.test(title)) {
    return titleCase(title);
  }

  const notes = String(row.full_notes || '').trim();
  if (notes) {
    const parts = notes
      .split('-')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (
        /^[A-Za-z .]{3,}$/.test(part) &&
        !/^(AB|PT|SP|BP|AP|ASP|PP|PM|MNG|BASIC|LOCATION|NIL)$/i.test(part)
      ) {
        return titleCase(part);
      }
    }
  }

  return `Legacy Booking ${rowIndex + 1}`;
};

const buildPlaceholderEmail = ({ name, phone, rowIndex }) => {
  const slug = slugify(name) || `legacy-${rowIndex + 1}`;
  const phonePart = cleanPhone(phone).slice(-10);
  return `${slug}${phonePart ? `-${phonePart}` : ''}@legacy.local`;
};

const buildImportKey = ({ customerName, bookingDate, service, phone }) =>
  [customerName, bookingDate, service, phone].join('|').toLowerCase();

const parseNormalizedStaffNames = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const main = async () => {
  const bookingsCsvPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_BOOKINGS_CSV;
  const packageReviewCsvPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : DEFAULT_PACKAGE_REVIEW_CSV;

  try {
    const [rows, packageReviewRows] = await Promise.all([
      parseCsv(bookingsCsvPath),
      parseCsv(packageReviewCsvPath),
    ]);

    if (rows.length === 0) {
      throw new Error(`No booking rows found in ${bookingsCsvPath}`);
    }

    await connectDB();

    const [regions, packages, employees, bookings] = await Promise.all([
      Region.find({}),
      ServicePackage.find({}),
      Employee.find({}),
      Booking.find({}, 'customerName bookingDate service phone'),
    ]);

    const regionByName = new Map(
      regions.map((region) => [region.name.trim().toLowerCase(), region])
    );
    const packageNameByCode = new Map();
    for (const row of packageReviewRows) {
      const code = String(row.package_code || '').trim();
      const name = String(row.suggested_name || '').trim();
      if (code && name) {
        packageNameByCode.set(code, name);
      }
    }

    const packageByName = new Map(
      packages.map((servicePackage) => [
        servicePackage.name.trim().toLowerCase(),
        servicePackage,
      ])
    );
    const employeeByName = new Map(
      employees.map((employee) => [employee.name.trim().toLowerCase(), employee])
    );
    const existingImportKeys = new Set(
      bookings.map((booking) =>
        buildImportKey({
          customerName: booking.customerName,
          bookingDate: formatDateOnly(new Date(booking.bookingDate)),
          service: booking.service,
          phone: booking.phone || '',
        })
      )
    );

    let createdBookings = 0;
    let skippedBookings = 0;
    let createdCustomers = 0;
    let createdEmployees = 0;
    let createdRegions = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const bookingDate = parseDateOnly(row.booking_date);
      if (!bookingDate) {
        skippedBookings += 1;
        continue;
      }

      const customerName = extractCustomerName(row, index);
      const normalizedRegion = String(row.normalized_region || '').trim();
      const packageCode = String(row.package || '').trim();
      const packageName = packageNameByCode.get(packageCode) || packageCode;
      const serviceName = packageName || 'Legacy Booking';
      const primaryPhone = cleanPhone(row.phone_bride || row.phone || '');
      const importKey = buildImportKey({
        customerName,
        bookingDate: formatDateOnly(bookingDate),
        service: serviceName,
        phone: primaryPhone,
      });

      if (existingImportKeys.has(importKey)) {
        skippedBookings += 1;
        continue;
      }

      let regionDoc = null;
      if (normalizedRegion) {
        regionDoc = regionByName.get(normalizedRegion.toLowerCase()) || null;
        if (!regionDoc) {
          regionDoc = await Region.create({ name: normalizedRegion, status: 'active' });
          regionByName.set(normalizedRegion.toLowerCase(), regionDoc);
          createdRegions += 1;
        }
      }

      const servicePackage = packageByName.get(serviceName.toLowerCase()) || null;
      const selectedDates = enumerateSelectedDates(row.booking_date, row.end_date);
      const slotStart =
        parseTimeToken(row.starting_time) || parseTimeToken(row.service_time);
      const slotEnd = parseTimeToken(row.completing_time);
      const serviceStart = combineDateAndTime(bookingDate, slotStart, 9);
      const serviceEnd = slotEnd
        ? combineDateAndTime(bookingDate, slotEnd, slotStart?.hours ?? 10)
        : new Date(serviceStart.getTime() + 60 * 60 * 1000);
      if (serviceEnd <= serviceStart) {
        serviceEnd.setTime(serviceStart.getTime() + 60 * 60 * 1000);
      }

      const customerEmail = buildPlaceholderEmail({
        name: customerName,
        phone: primaryPhone,
        rowIndex: index,
      });
      const customerLookup = primaryPhone
        ? { $or: [{ phone: primaryPhone }, { email: customerEmail }] }
        : { email: customerEmail };
      let customer = await Customer.findOne(customerLookup);
      if (!customer) {
        customer = await Customer.create({
          name: customerName,
          email: customerEmail,
          phone: primaryPhone,
          status: 'Active',
        });
        createdCustomers += 1;
      }

      const assignedStaffNames = parseNormalizedStaffNames(
        row.normalized_staff_needed
      );
      const assignedStaff = [];
      for (let staffIndex = 0; staffIndex < assignedStaffNames.length; staffIndex += 1) {
        const staffName = assignedStaffNames[staffIndex];
        let employee = employeeByName.get(staffName.toLowerCase()) || null;
        if (!employee) {
          employee = await Employee.create({
            name: staffName,
            email: '',
            phone: '',
            type: 'outsource',
            artistRole: 'artist',
            specialization: '',
            works: [],
            status: 'active',
          });
          employeeByName.set(staffName.toLowerCase(), employee);
          createdEmployees += 1;
        }

        assignedStaff.push({
          employeeId: employee._id,
          artistName: employee.name,
          role: employee.role || employee.artistRole || 'artist',
          specialization: employee.specialization || '',
          works: serviceName ? [serviceName] : [],
          phone: employee.phone || '',
          type: employee.type || '',
          roleType: staffIndex === 0 ? 'lead' : 'assistant',
        });
      }

      const totalPrice = servicePackage?.price ?? 0;
      const advanceAmount = servicePackage?.advanceAmount ?? 3000;
      const notes = [
        row.full_notes ? `Legacy notes: ${row.full_notes}` : '',
        row.booking_ref ? `Legacy ref: ${row.booking_ref}` : '',
        row.travel_time ? `Travel time: ${row.travel_time}` : '',
        row.mode_of_travel ? `Travel mode: ${row.mode_of_travel}` : '',
      ]
        .filter(Boolean)
        .join(' | ');

      await Booking.create({
        packageId: servicePackage?._id,
        regionId: regionDoc?._id,
        customerName,
        email: customerEmail,
        legacyBooking: true,
        phone: primaryPhone,
        service: serviceName,
        region: normalizedRegion,
        status: mapLegacyStatus(row.status),
        mapUrl: row.map_url || '',
        travelMode: row.mode_of_travel || '',
        travelTime: row.travel_time || '',
        eventSlot: row.service_time || '',
        requiredRoomDetail: row.required_room || '',
        secondaryContact: cleanPhone(row.phone_poc || ''),
        outfitDetails: row.outfit || '',
        captureStaffDetails: row.capture_staff || '',
        temporaryStaffDetails: row.staff_needed || '',
        internalRemarks: notes,
        contentCreationRequired: /yes|required|need/i.test(
          String(row.content_required || '')
        ),
        bookingDate,
        selectedDates: selectedDates.length > 0 ? selectedDates : [formatDateOnly(bookingDate)],
        serviceStart,
        serviceEnd,
        totalPrice,
        advanceAmount,
        assignedStaff,
        bookingItems: [
          {
            packageId: servicePackage?._id,
            service: serviceName,
            eventSlot: row.service_time || '',
            selectedDates:
              selectedDates.length > 0
                ? selectedDates
                : [formatDateOnly(bookingDate)],
            totalPrice,
            advanceAmount,
            assignedStaff,
          },
        ],
      });

      existingImportKeys.add(importKey);
      createdBookings += 1;
    }

    console.log('\nLegacy booking import complete.');
    console.log(`Bookings CSV: ${bookingsCsvPath}`);
    console.log(`Package mapping CSV: ${packageReviewCsvPath}`);
    console.log(`Bookings created: ${createdBookings}`);
    console.log(`Bookings skipped: ${skippedBookings}`);
    console.log(`Customers created: ${createdCustomers}`);
    console.log(`Employees created: ${createdEmployees}`);
    console.log(`Regions created: ${createdRegions}`);
  } catch (error) {
    console.error(`Legacy booking import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
