import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import Region from '../models/Region.js';

dotenv.config();

const DEFAULT_XLSX_PATH = '/Users/muhammedrisan/Downloads/sale_data_2026_updated.xlsx';
const GENERATED_CSV_PATH = path.resolve(process.cwd(), 'tmp', 'sale_data_2026_updated.csv');
const CONVERTER_SCRIPT = path.resolve(
  process.cwd(),
  'scripts',
  'convertSalesData2026XlsxToCsv.py'
);
const SERVICE_NAME = 'Custom Package';

const DISTRICT_MAP = new Map([
  ['thiruvananthapuram', 'Thiruvananthapuram'],
  ['trivandrum', 'Thiruvananthapuram'],
  ['tvm', 'Thiruvananthapuram'],
  ['kollam', 'Kollam'],
  ['pathanamthitta', 'Pathanamthitta'],
  ['alappuzha', 'Alappuzha'],
  ['alleppey', 'Alappuzha'],
  ['kottayam', 'Kottayam'],
  ['idukki', 'Idukki'],
  ['ernakulam', 'Ernakulam'],
  ['ekm', 'Ernakulam'],
  ['kochi', 'Ernakulam'],
  ['thrissur', 'Thrissur'],
  ['trissur', 'Thrissur'],
  ['tsr', 'Thrissur'],
  ['palakkad', 'Palakkad'],
  ['palghat', 'Palakkad'],
  ['malappuram', 'Malappuram'],
  ['kozhikode', 'Kozhikode'],
  ['calicut', 'Kozhikode'],
  ['clt', 'Kozhikode'],
  ['wayanad', 'Wayanad'],
  ['kannur', 'Kannur'],
  ['kasaragod', 'Kasaragod'],
  ['kasargod', 'Kasaragod'],
]);

const normalize = (value) => String(value || '').trim().toLowerCase();

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

const cleanCurrency = (value) => {
  const parsed = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseDmyDate = (value) => {
  const parts = String(value || '')
    .trim()
    .split('-')
    .map((item) => Number(item));
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

const buildPlaceholderEmail = (clientId, name) => {
  const slug = String(name || 'legacy-sale')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = String(clientId || 'legacy')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return `${slug || 'legacy-sale'}-${suffix || 'legacy'}@legacy.local`;
};

const buildImportKey = ({ customerName, eventDate, clientId }) =>
  [customerName, eventDate, clientId].join('|').toLowerCase();

const main = async () => {
  const xlsxPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_XLSX_PATH;

  try {
    execFileSync('python3', [CONVERTER_SCRIPT, xlsxPath, GENERATED_CSV_PATH], {
      stdio: 'inherit',
    });

    const rows = await parseCsv(GENERATED_CSV_PATH);
    if (rows.length === 0) {
      throw new Error(`No rows found in ${GENERATED_CSV_PATH}`);
    }

    await connectDB();

    const regions = await Region.find({});
    const regionByName = new Map(regions.map((region) => [normalize(region.name), region]));
    const existingBookings = await Booking.find(
      { legacyBooking: true, service: SERVICE_NAME },
      'customerName bookingDate internalRemarks'
    );
    const existingKeys = new Set(
      existingBookings.map((booking) => {
        const clientIdMatch = String(booking.internalRemarks || '').match(
          /Legacy sale client id: ([^|]+)/i
        );
        return buildImportKey({
          customerName: booking.customerName,
          eventDate: formatDateOnly(new Date(booking.bookingDate)),
          clientId: clientIdMatch ? clientIdMatch[1].trim() : '',
        });
      })
    );

    let createdCustomers = 0;
    let createdBookings = 0;
    let skippedRows = 0;

    for (const row of rows) {
      const clientName = String(row['Client Name'] || '').trim();
      const clientId = String(row['Client_ID'] || '').trim();
      const regionName = DISTRICT_MAP.get(normalize(row.Region)) ?? '';
      const eventDate = parseDmyDate(row['Event Date']);
      const saleDate = parseDmyDate(row['Sale Date']) || eventDate;

      if (!clientName || !clientId || !eventDate || !saleDate) {
        skippedRows += 1;
        continue;
      }

      const importKey = buildImportKey({
        customerName: clientName,
        eventDate: formatDateOnly(eventDate),
        clientId,
      });
      if (existingKeys.has(importKey)) {
        skippedRows += 1;
        continue;
      }

      let region = regionName ? regionByName.get(normalize(regionName)) : null;
      if (regionName && !region) {
        region = await Region.create({ name: regionName, status: 'active' });
        regionByName.set(normalize(regionName), region);
      }

      const phone = String(row['Client Phone'] || '').trim();
      const email = buildPlaceholderEmail(clientId, clientName);
      const customerLookup = phone ? { $or: [{ phone }, { email }] } : { email };

      let customer = await Customer.findOne(customerLookup);
      if (!customer) {
        customer = await Customer.create({
          name: clientName,
          email,
          phone,
          status: 'Active',
          company: '',
        });
        createdCustomers += 1;
      }

      const forecastAmount = cleanCurrency(row['Forecast Amount']);
      const advanceAmount = cleanCurrency(row['Advance Amount']);
      const totalPrice = forecastAmount + advanceAmount;
      const serviceStart = new Date(eventDate);
      serviceStart.setHours(9, 0, 0, 0);
      const serviceEnd = new Date(eventDate);
      serviceEnd.setHours(10, 0, 0, 0);

      await Booking.create({
        customerName: clientName,
        email,
        legacyBooking: true,
        phone,
        service: SERVICE_NAME,
        regionId: region?._id,
        region: regionName,
        status: 'confirmed',
        bookingDate: eventDate,
        selectedDates: [formatDateOnly(eventDate)],
        serviceStart,
        serviceEnd,
        totalPrice,
        advanceAmount,
        internalRemarks: [
          `Legacy sale client id: ${clientId}`,
          row['sale source'] ? `Sale source: ${row['sale source']}` : '',
          row.Timestamp ? `Timestamp: ${row.Timestamp}` : '',
          row['Sale Date'] ? `Sale date: ${row['Sale Date']}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
        bookingItems: [
          {
            service: SERVICE_NAME,
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

    console.log('Sale data import complete.');
    console.log(`File: ${xlsxPath}`);
    console.log(`Customers created: ${createdCustomers}`);
    console.log(`Bookings created: ${createdBookings}`);
    console.log(`Rows skipped: ${skippedRows}`);
  } catch (error) {
    console.error(`Sale data import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
