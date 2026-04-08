import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import ServicePackage from '../models/Package.js';

dotenv.config();

const DEFAULT_CSV_PATH = path.resolve(
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

const normalizeDescription = (description, code, count) => {
  const pieces = [];
  if (description) {
    pieces.push(description.trim());
  }
  pieces.push(`Legacy import code: ${code}`);
  if (count) {
    pieces.push(`Observed in ${count} CSV row(s)`);
  }
  return pieces.join(' | ');
};

const main = async () => {
  const csvPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_CSV_PATH;

  try {
    const rows = await parseCsv(csvPath);

    if (rows.length === 0) {
      throw new Error(`No rows found in ${csvPath}`);
    }

    await connectDB();

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const code = (row.package_code || '').trim();
      const name = (row.suggested_name || '').trim();
      const price = Number(row.base_price);
      const advanceAmount = Number(row.advance_amount || 3000);
      const count = Number(row.count || 0);
      const description = normalizeDescription(
        row.description || '',
        code || 'UNKNOWN',
        Number.isFinite(count) ? count : 0
      );

      if (!name || !Number.isFinite(price) || price < 0) {
        skipped += 1;
        console.log(
          `Skipping row for code "${code}" because name or base_price is missing/invalid.`
        );
        continue;
      }

      const existing = await ServicePackage.findOne({ name });

      if (existing) {
        existing.price = price;
        existing.advanceAmount =
          Number.isFinite(advanceAmount) && advanceAmount >= 0
            ? advanceAmount
            : existing.advanceAmount;
        existing.description = description;
        await existing.save();
        updated += 1;
        console.log(`Updated package: ${name}`);
      } else {
        await ServicePackage.create({
          name,
          price,
          advanceAmount:
            Number.isFinite(advanceAmount) && advanceAmount >= 0
              ? advanceAmount
              : 3000,
          description,
          regionPrices: [],
        });
        created += 1;
        console.log(`Created package: ${name}`);
      }
    }

    console.log('\nPackage import complete.');
    console.log(`CSV: ${csvPath}`);
    console.log(`Created: ${created}`);
    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);
  } catch (error) {
    console.error(`Package import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
