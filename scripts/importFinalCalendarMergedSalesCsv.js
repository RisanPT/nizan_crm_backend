import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import Region from '../models/Region.js';

dotenv.config();

const DEFAULT_FILE =
  '/Users/muhammedrisan/Downloads/final_calendar_merged_sales_report.csv.csv';

const DISTRICT_MAP = new Map([
  ['thiruvananthapuram', 'Thiruvananthapuram'],
  ['trivandrum', 'Thiruvananthapuram'],
  ['tvm', 'Thiruvananthapuram'],
  ['kollam', 'Kollam'],
  ['pathanamthitta', 'Pathanamthitta'],
  ['alappuzha', 'Alappuzha'],
  ['allapuzha', 'Alappuzha'],
  ['alleppey', 'Alappuzha'],
  ['kottayam', 'Kottayam'],
  ['kottyam', 'Kottayam'],
  ['idukki', 'Idukki'],
  ['ernakulam', 'Ernakulam'],
  ['eranakulam', 'Ernakulam'],
  ['eranakulam', 'Ernakulam'],
  ['ekm', 'Ernakulam'],
  ['kochi', 'Ernakulam'],
  ['kochin', 'Ernakulam'],
  ['thrissur', 'Thrissur'],
  ['thrissure', 'Thrissur'],
  ['trissur', 'Thrissur'],
  ['trissure', 'Thrissur'],
  ['trissur.', 'Thrissur'],
  ['trissur dt', 'Thrissur'],
  ['trissur district', 'Thrissur'],
  ['trissur district kerala', 'Thrissur'],
  ['thrissur dt', 'Thrissur'],
  ['thrissur district', 'Thrissur'],
  ['thrissur district kerala', 'Thrissur'],
  ['tsr', 'Thrissur'],
  ['trissur ', 'Thrissur'],
  ['trissur\t', 'Thrissur'],
  ['malappuram', 'Malappuram'],
  ['malapuram', 'Malappuram'],
  ['malapurm', 'Malappuram'],
  ['kozhikode', 'Kozhikode'],
  ['kozhkode', 'Kozhikode'],
  ['kozhkode', 'Kozhikode'],
  ['kozikode', 'Kozhikode'],
  ['calicut', 'Kozhikode'],
  ['clt', 'Kozhikode'],
  ['wayanad', 'Wayanad'],
  ['kannur', 'Kannur'],
  ['kasaragod', 'Kasaragod'],
  ['kasargod', 'Kasaragod'],
  ['palakkad', 'Palakkad'],
  ['palghat', 'Palakkad'],
]);

const LOCATION_REGION_MAP = new Map([
  ['calicut', 'Kozhikode'],
  ['kozhikode', 'Kozhikode'],
  ['chelari', 'Malappuram'],
  ['taliparamba', 'Kannur'],
  ['kannur', 'Kannur'],
  ['kochi', 'Ernakulam'],
  ['kochin', 'Ernakulam'],
  ['thrissur', 'Thrissur'],
  ['trissur', 'Thrissur'],
  ['palakkad', 'Palakkad'],
  ['malappuram', 'Malappuram'],
  ['idukki', 'Idukki'],
  ['alappuzha', 'Alappuzha'],
  ['pathanamthitta', 'Pathanamthitta'],
  ['kottayam', 'Kottayam'],
  ['kollam', 'Kollam'],
  ['trivandrum', 'Thiruvananthapuram'],
  ['thiruvananthapuram', 'Thiruvananthapuram'],
  ['kasaragod', 'Kasaragod'],
  ['wayanad', 'Wayanad'],
]);

const normalize = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const parseCsvLine = (line) => {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
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

  const rawHeaders = parseCsvLine(lines[0]);
  const headerCounts = new Map();
  const headers = rawHeaders.map((header) => {
    const count = (headerCounts.get(header) ?? 0) + 1;
    headerCounts.set(header, count);
    return count === 1 ? header : `${header}__${count}`;
  });

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? '';
      return acc;
    }, {});
  });
};

const cleanCurrency = (value) => {
  const parsed = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseDmyDate = (value) => {
  const cleaned = String(value || '').trim();
  if (!cleaned) return null;
  const parts = cleaned.split('-').map((item) => Number(item));
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) {
    return null;
  }

  const [day, month, year] = parts;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateOnly = (date) => {
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const cleanPhone = (value) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/(?!^\+)[^\d]/g, '')
    .trim();

const formatClientName = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const buildPlaceholderEmail = (name, dateText) => {
  const slug = String(name || 'legacy-sale')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = String(dateText || 'legacy').replace(/[^0-9]/g, '');
  return `${slug || 'legacy-sale'}-${suffix || 'legacy'}@legacy.local`;
};

const normalizeDistrict = (districtValue, locationValue) => {
  const direct = DISTRICT_MAP.get(normalize(districtValue));
  if (direct) return direct;

  const location = normalize(locationValue);
  if (!location) return '';

  for (const [key, district] of LOCATION_REGION_MAP.entries()) {
    if (location.includes(key)) {
      return district;
    }
  }

  return '';
};

const parseTimeOnDate = (date, rawValue, fallbackHour) => {
  const cleaned = String(rawValue || '')
    .replace(/\s+/g, '')
    .replace(/\./g, ':')
    .toUpperCase()
    .trim();

  const fallback = new Date(date);
  fallback.setHours(fallbackHour, 0, 0, 0);

  if (!cleaned || cleaned === 'NOTFIXED' || cleaned === 'MNG') {
    return fallback;
  }

  const simpleHour = cleaned.match(/^(\d{1,2})$/);
  if (simpleHour) {
    const parsedHour = Number(simpleHour[1]);
    if (parsedHour >= 0 && parsedHour <= 23) {
      const withHour = new Date(date);
      withHour.setHours(parsedHour, 0, 0, 0);
      return withHour;
    }
  }

  const match = cleaned.match(/^(\d{1,2})(?::?(\d{2}))?(AM|PM)$/);
  if (!match) {
    return fallback;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const meridiem = match[3];

  if (hour === 12) {
    hour = meridiem === 'AM' ? 0 : 12;
  } else if (meridiem === 'PM') {
    hour += 12;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  const parsed = new Date(date);
  parsed.setHours(hour, minute, 0, 0);
  return parsed;
};

const buildImportKey = ({
  customerName,
  eventDate,
  primaryPhone,
  secondaryPhone,
  totalPrice,
}) =>
  [customerName, eventDate, primaryPhone, secondaryPhone, totalPrice]
    .join('|')
    .toLowerCase();

const customPackageNameFromRaw = (rawPackage) => {
  const value = String(rawPackage || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Custom Package';
  const upper = value.toUpperCase();
  if (upper === 'AB' || upper === 'PT') return upper;
  return value;
};

const main = async () => {
  const filePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_FILE;

  try {
    const rows = await parseCsv(filePath);
    if (rows.length === 0) {
      throw new Error(`No rows found in ${filePath}`);
    }

    await connectDB();

    const regions = await Region.find({});
    const regionByName = new Map(
      regions.map((region) => [normalize(region.name), region])
    );

    const existingBookings = await Booking.find(
      { legacyBooking: true },
      'customerName bookingDate phone totalPrice secondaryContact'
    );

    const existingKeys = new Set(
      existingBookings.map((booking) =>
        buildImportKey({
          customerName: booking.customerName,
          eventDate: formatDateOnly(new Date(booking.bookingDate)),
          primaryPhone: cleanPhone(booking.phone),
          secondaryPhone: cleanPhone(booking.secondaryContact),
          totalPrice: Number(booking.totalPrice || 0).toFixed(0),
        })
      )
    );

    let createdCustomers = 0;
    let createdBookings = 0;
    let skippedRows = 0;

    for (const row of rows) {
      const clientName = formatClientName(row['Client Name']);
      const eventDate = parseDmyDate(row['Event Date(Date)']);
      const saleDate = parseDmyDate(row['Sale Date']) || eventDate;
      const primaryPhone = cleanPhone(row['Bride Phone (B)']);
      const secondaryPhone = cleanPhone(row['Additional Phone (P)']);
      const forecastAmount = cleanCurrency(row['Forecast Amount']);
      const advanceAmount = cleanCurrency(row['Advance Amount']);
      const totalPrice = forecastAmount + advanceAmount;

      if (!clientName || !eventDate || !saleDate || totalPrice <= 0) {
        skippedRows += 1;
        continue;
      }

      const district = normalizeDistrict(
        row.District,
        row.Location__2 || row.Location
      );

      let region = district ? regionByName.get(normalize(district)) : null;
      if (district && !region) {
        region = await Region.create({ name: district, status: 'active' });
        regionByName.set(normalize(district), region);
      }

      const importKey = buildImportKey({
        customerName: clientName,
        eventDate: formatDateOnly(eventDate),
        primaryPhone,
        secondaryPhone,
        totalPrice: totalPrice.toFixed(0),
      });

      if (existingKeys.has(importKey)) {
        skippedRows += 1;
        continue;
      }

      const email = buildPlaceholderEmail(clientName, formatDateOnly(eventDate));
      const customerLookup = primaryPhone
        ? { $or: [{ phone: primaryPhone }, { email }] }
        : { email };

      let customer = await Customer.findOne(customerLookup);
      if (!customer) {
        customer = await Customer.create({
          name: clientName,
          email,
          phone: primaryPhone,
          status: 'Active',
          company: '',
        });
        createdCustomers += 1;
      }

      const serviceName = customPackageNameFromRaw(row.Package);
      const serviceStart = parseTimeOnDate(
        eventDate,
        row['Starting Time'],
        9
      );
      const serviceEnd = parseTimeOnDate(
        eventDate,
        row['Completing Time'],
        10
      );

      await Booking.create({
        customerName: clientName,
        email,
        legacyBooking: true,
        phone: primaryPhone,
        secondaryContact: secondaryPhone,
        service: serviceName,
        regionId: region?._id,
        region: district,
        status: 'confirmed',
        bookingDate: eventDate,
        selectedDates: [formatDateOnly(eventDate)],
        serviceStart,
        serviceEnd,
        totalPrice,
        advanceAmount,
        mapUrl: String(row.mapurl || '').trim(),
        outfitDetails: String(row.Outfit || '').trim(),
        internalRemarks: [
          `Imported from: ${path.basename(filePath)}`,
          `Sale date: ${formatDateOnly(saleDate)}`,
          row.Package ? `Raw package: ${String(row.Package).trim()}` : '',
          row.District ? `Raw district: ${String(row.District).trim()}` : '',
          row.Location ? `Location: ${String(row.Location).trim()}` : '',
          row.Location__2
            ? `Location detail: ${String(row.Location__2).trim()}`
            : '',
        ]
          .filter(Boolean)
          .join(' | '),
        bookingItems: [
          {
            service: serviceName,
            eventSlot: '',
            selectedDates: [formatDateOnly(eventDate)],
            totalPrice,
            advanceAmount,
            assignedStaff: [],
          },
        ],
      });

      existingKeys.add(importKey);
      createdBookings += 1;
    }

    console.log('Final calendar merged sales import complete.');
    console.log(`File: ${filePath}`);
    console.log(`Customers created: ${createdCustomers}`);
    console.log(`Bookings created: ${createdBookings}`);
    console.log(`Rows skipped: ${skippedRows}`);
  } catch (error) {
    console.error(`Final calendar merged sales import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
