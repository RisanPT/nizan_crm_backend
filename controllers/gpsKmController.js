import { cleanGpsRows, MAX_ROWS } from '../utils/gpsKm.js';
import { addDays, DAY_MS, istStart, parseDayParam, todayIst } from '../utils/istDate.js';
import { compareGpsKm, recentUploads, saveGpsRows } from '../services/gpsKm.js';

const MAX_RANGE_DAYS = 366;

// @desc    Save a GPS tracker km report (the app has already read the spreadsheet)
// @route   POST /api/fleet/gps-km/upload   { fileName, rows: [{ registrationNumber, date, distanceKm, … }] }
// @access  Private (fleet_manager / admin / manager)
export const uploadGpsKm = async (req, res) => {
  try {
    const { fileName, rows } = req.body ?? {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'There are no rows in this report.' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ message: `A report can have at most ${MAX_ROWS} rows; this one has ${rows.length}. Upload it in parts.` });
    }

    const clean = cleanGpsRows(rows, { today: todayIst() });
    if (clean.rows.length === 0) {
      return res.status(400).json({
        message: 'None of the rows could be used.',
        problems: clean.problems,
        skipped: clean.skipped,
      });
    }

    const { upload, created, updated, unchanged } = await saveGpsRows({
      rows: clean.rows,
      skipped: clean.skipped,
      fileName,
      user: req.user,
    });

    res.status(201).json({
      uploadId: upload._id,
      from: upload.from,
      to: upload.to,
      rows: clean.rows.length,
      created,
      updated,
      unchanged,
      skipped: clean.skipped,
      duplicates: clean.duplicates,
      problems: clean.problems,
      vehicles: upload.vehicles,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Driver-entered km vs the uploaded GPS km
// @route   GET /api/fleet/gps-km/compare?from=&to=&vehicleId=
// @access  Private (fleet_manager / admin / manager)
// Without from / to it shows the days of the latest upload (or the last 30 days if nothing
// has been uploaded yet).
export const getGpsKmComparison = async (req, res) => {
  try {
    const uploads = await recentUploads(5);
    const latest = uploads[0];

    let to = parseDayParam(req.query.to);
    let from = parseDayParam(req.query.from);
    if (!from && !to) {
      to = latest?.to || todayIst();
      from = latest?.from || addDays(to, -29);
      // a long report still opens on something showable: its most recent year
      if ((istStart(to) - istStart(from)) / DAY_MS > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
    } else {
      to = to || todayIst();
      from = from || addDays(to, -29);
    }
    if (from > to) return res.status(400).json({ message: 'The start date must be on or before the end date.' });
    if ((istStart(to) - istStart(from)) / DAY_MS > MAX_RANGE_DAYS) {
      return res.status(400).json({ message: 'Pick a range of a year or less.' });
    }

    const result = await compareGpsKm({ from, to, vehicleId: req.query.vehicleId || null });
    res.json({
      ...result,
      defaulted: !req.query.from && !req.query.to,
      uploads: uploads.map((u) => ({
        id: u._id,
        fileName: u.fileName,
        uploadedByName: u.uploadedByName,
        from: u.from,
        to: u.to,
        rows: u.rows,
        created: u.created,
        updated: u.updated,
        uploadedAt: u.createdAt,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
