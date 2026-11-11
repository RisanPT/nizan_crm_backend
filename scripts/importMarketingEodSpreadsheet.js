import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import XLSX from 'xlsx';

import connectDB from '../config/db.js';
import {
  MarketingGroup,
  MarketingRole,
  MarketingMetric,
  MarketingTeamMember,
  MarketingTarget,
  MarketingEodEntry,
} from '../models/MarketingEod.js';

dotenv.config();

// Convert Excel serial date number to YYYY-MM-DD
function excelSerialToDateStr(serial) {
  if (typeof serial === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(serial)) return serial;
    const d = new Date(serial);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof serial === 'number') {
    // Excel base date: Dec 30, 1899
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400;
    const dateInfo = new Date(utcValue * 1000);
    return dateInfo.toISOString().slice(0, 10);
  }
  return null;
}

export const importSpreadsheet = async (filePath) => {
  try {
    await connectDB();
    console.log(`[Import] Reading spreadsheet from: ${filePath}`);

    const wb = XLSX.readFile(filePath);
    const sheetNames = wb.SheetNames;
    console.log(`[Import] Found sheets:`, sheetNames);

    if (!sheetNames.includes('EOD Log')) {
      console.error('[Import] "EOD Log" sheet not found in workbook!');
      process.exit(1);
    }

    // 1. Preload Members and Metrics from DB
    const members = await MarketingTeamMember.find();
    const metrics = await MarketingMetric.find();

    const memberMap = new Map();
    for (const m of members) {
      memberMap.set(m.name.toLowerCase().trim(), m);
      memberMap.set(m.shortName.toLowerCase().trim(), m);
    }

    const metricMap = new Map();
    for (const met of metrics) {
      metricMap.set(met.name.toLowerCase().trim(), met);
    }

    // 2. Parse EOD Log sheet
    const eodSheet = wb.Sheets['EOD Log'];
    const logData = XLSX.utils.sheet_to_json(eodSheet, { header: 1 });

    if (logData.length < 5) {
      console.log('[Import] No data found in EOD Log.');
      process.exit(0);
    }

    // Header is on row index 4 (0-based)
    const headerRow = logData[4];
    console.log('[Import] Header row columns:', headerRow.length);

    // Map column index to metric
    const colMetricMap = new Map();
    let hoursColIdx = -1;

    for (let c = 2; c < headerRow.length; c++) {
      const colName = String(headerRow[c] || '').trim();
      if (!colName) continue;

      if (colName.toLowerCase().includes('hours worked') || colName.toLowerCase() === 'hours') {
        hoursColIdx = c;
        continue;
      }

      const matchMetric = metricMap.get(colName.toLowerCase());
      if (matchMetric) {
        colMetricMap.set(c, matchMetric);
      }
    }

    console.log(`[Import] Mapped ${colMetricMap.size} metric columns. Hours column index: ${hoursColIdx}`);

    let importedCount = 0;
    let skippedCount = 0;

    for (let r = 5; r < logData.length; r++) {
      const row = logData[r];
      if (!row || row.length < 2) continue;

      const dateSerial = row[0];
      const memberName = String(row[1] || '').trim();
      if (!dateSerial || !memberName) continue;

      const entryDate = excelSerialToDateStr(dateSerial);
      if (!entryDate) continue;

      const member = memberMap.get(memberName.toLowerCase());
      if (!member) {
        skippedCount++;
        continue;
      }

      const hours = hoursColIdx !== -1 ? Number(row[hoursColIdx]) || 0 : 0;
      const values = [];

      for (const [colIdx, metric] of colMetricMap.entries()) {
        const val = Number(row[colIdx]) || 0;
        if (val > 0) {
          values.add ? values.push({ metricId: metric._id, value: val }) : values.push({ metricId: metric._id, value: val });
        }
      }

      // Only import if row has hours or at least one metric value > 0
      if (hours > 0 || values.length > 0) {
        await MarketingEodEntry.findOneAndUpdate(
          { memberId: member._id, entryDate },
          {
            memberId: member._id,
            entryDate,
            hoursWorked: hours,
            values,
            checkStatus: hours > 0 ? 'OK' : 'WARNING',
            checkMessage: hours > 0 ? 'OK' : 'Hours missing',
            submittedAt: new Date(),
          },
          { upsert: true }
        );
        importedCount++;
      } else {
        skippedCount++;
      }
    }

    console.log(`[Import] Done! Imported/Updated ${importedCount} actual entries. Skipped ${skippedCount} blank template rows.`);

    // 3. Optional: Targets from Setup sheet
    if (sheetNames.includes('Setup')) {
      const setupSheet = wb.Sheets['Setup'];
      const setupData = XLSX.utils.sheet_to_json(setupSheet, { header: 1 });
      let targetRowStart = -1;

      for (let i = 0; i < 20; i++) {
        if (setupData[i] && String(setupData[i][0]).toLowerCase().includes('group') && String(setupData[i][1]).toLowerCase().includes('metric')) {
          targetRowStart = i;
          break;
        }
      }

      if (targetRowStart !== -1) {
        const targetHeader = setupData[targetRowStart];
        const memberCols = [];
        for (let c = 3; c < targetHeader.length; c++) {
          const mName = String(targetHeader[c] || '').trim();
          const mem = memberMap.get(mName.toLowerCase());
          if (mem) {
            memberCols.push({ colIdx: c, member: mem });
          }
        }

        let targetsImported = 0;
        for (let r = targetRowStart + 1; r < setupData.length; r++) {
          const row = setupData[r];
          if (!row || !row[1]) break;
          const metName = String(row[1]).trim();
          const metric = metricMap.get(metName.toLowerCase());
          if (!metric) continue;

          for (const mCol of memberCols) {
            const val = row[mCol.colIdx];
            if (val !== null && val !== undefined && val !== '' && !isNaN(Number(val))) {
              await MarketingTarget.findOneAndUpdate(
                { memberId: mCol.member._id, metricId: metric._id, month: '2026-10' },
                {
                  memberId: mCol.member._id,
                  metricId: metric._id,
                  month: '2026-10',
                  targetValue: Number(val),
                  setAt: new Date(),
                },
                { upsert: true }
              );
              targetsImported++;
            }
          }
        }
        console.log(`[Import] Imported ${targetsImported} monthly targets from Setup sheet for 2026-10.`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error('[Import] Error importing spreadsheet:', err);
    process.exit(1);
  }
};

const filePath = process.argv[2] || path.resolve('d:/Nizan/Team_N_Marketing_EOD_Tracker_v2 (1).xlsx');
importSpreadsheet(filePath);
