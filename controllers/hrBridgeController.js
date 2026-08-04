/**
 * hrBridgeController.js
 *
 * Proxy controller that forwards requests to the PHP attendance system's
 * api_bridge.php and returns clean JSON to the Flutter app.
 *
 * All calls are authenticated via the shared PHP_BRIDGE_API_KEY header so
 * the PHP system never needs to be exposed publicly to mobile clients.
 *
 * Env vars required in .env:
 *   PHP_BRIDGE_URL      = https://your-php-site.com/api_bridge.php
 *   PHP_BRIDGE_API_KEY  = <same secret set in the PHP project>
 */

const PHP_URL = process.env.PHP_BRIDGE_URL || '';
const PHP_KEY = process.env.PHP_BRIDGE_API_KEY || '';

/** Shared fetch helper — adds the API key header and checks for errors. */
async function phpFetch(params) {
  if (!PHP_URL) {
    throw new Error('PHP_BRIDGE_URL is not configured in .env');
  }
  if (!PHP_KEY) {
    throw new Error('PHP_BRIDGE_API_KEY is not configured in .env');
  }

  const qs = new URLSearchParams(params).toString();
  const url = `${PHP_URL}?${qs}`;

  const response = await fetch(url, {
    headers: { 'X-Api-Key': PHP_KEY },
    // 10-second timeout
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 401) {
    throw new Error('PHP bridge rejected the API key — check PHP_BRIDGE_API_KEY');
  }
  if (!response.ok) {
    throw new Error(`PHP bridge returned HTTP ${response.status}`);
  }

  return response.json();
}

// ── GET /api/hr/staff ─────────────────────────────────────────────────────────
// Returns admin / management / HR staff from the PHP system.
export const getHrStaff = async (req, res) => {
  try {
    const data = await phpFetch({ action: 'staff' });
    res.json(data);
  } catch (err) {
    res.status(502).json({ message: `PHP bridge error: ${err.message}` });
  }
};

// ── GET /api/hr/attendance ────────────────────────────────────────────────────
// Query params: user_id (int), year (int), month (int)
export const getHrAttendance = async (req, res) => {
  const { user_id, year, month } = req.query;

  if (!user_id) {
    return res.status(400).json({ message: 'user_id query param is required' });
  }

  try {
    const data = await phpFetch({
      action: 'attendance',
      user_id,
      year:  year  || new Date().getFullYear(),
      month: month || new Date().getMonth() + 1,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ message: `PHP bridge error: ${err.message}` });
  }
};

// ── GET /api/hr/leaves ────────────────────────────────────────────────────────
// Query params: user_id (int), year (int), month (int)
export const getHrLeaves = async (req, res) => {
  const { user_id, year, month } = req.query;

  if (!user_id) {
    return res.status(400).json({ message: 'user_id query param is required' });
  }

  try {
    const data = await phpFetch({
      action: 'leaves',
      user_id,
      year:  year  || new Date().getFullYear(),
      month: month || new Date().getMonth() + 1,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ message: `PHP bridge error: ${err.message}` });
  }
};

// ── GET /api/hr/holidays ──────────────────────────────────────────────────────
// Query params: year (int), month (int)
export const getHrHolidays = async (req, res) => {
  const { year, month } = req.query;

  try {
    const data = await phpFetch({
      action: 'holidays',
      year:  year  || new Date().getFullYear(),
      month: month || new Date().getMonth() + 1,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ message: `PHP bridge error: ${err.message}` });
  }
};
