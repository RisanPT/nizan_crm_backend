import GeoCache from '../models/GeoCache.js';

// Pincode → coordinates via OpenStreetMap Nominatim, cached in GeoCache.
//
// Nominatim usage policy: max 1 request/second, an identifying User-Agent, and
// cache results. We queue lookups and drain them one at a time in the
// background, so a map request never waits on (or floods) the service.
// Only the pincode + country are sent — no client data.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim requires an identifying User-Agent.
const USER_AGENT = 'TeamN-ERP/1.0 (booking map; +https://api.teamnmakeovers.com)';
const GAP_MS = 1200; // a little over 1 req/s
const RETRY_ERROR_AFTER_MS = 6 * 60 * 60 * 1000; // retry failed lookups after 6h
const RETRY_NOT_FOUND_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // and misses after 30d

const queue = [];
const queued = new Set();
let draining = false;

const pinKey = (pin) => `pin:${pin}`;

/// Extract a 6-digit Indian pincode from a booking's pincode field or address.
export const pincodeOf = (booking) => {
  const direct = String(booking?.pincode ?? '').replace(/\D/g, '');
  if (/^[1-9]\d{5}$/.test(direct)) return direct;
  const m = String(booking?.address ?? '').match(/(?<!\d)([1-9]\d{2})\s?(\d{3})(?!\d)/);
  return m ? `${m[1]}${m[2]}` : '';
};

/// Cached coordinates for pincodes: Map(pin → {lat,lng,label,district}).
/// Unknown / stale pins are queued for a background lookup.
export const coordsForPincodes = async (pins) => {
  const unique = [...new Set(pins.filter(Boolean))];
  const out = new Map();
  if (unique.length === 0) return { coords: out, pending: 0 };

  const rows = await GeoCache.find({ key: { $in: unique.map(pinKey) } }).lean();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const now = Date.now();
  for (const pin of unique) {
    const row = byKey.get(pinKey(pin));
    if (row?.status === 'ok' && row.lat != null && row.lng != null) {
      out.set(pin, { lat: row.lat, lng: row.lng, label: row.label, district: row.district });
      continue;
    }
    const age = row ? now - new Date(row.updatedAt).getTime() : Infinity;
    const stale =
      !row ||
      (row.status === 'error' && age > RETRY_ERROR_AFTER_MS) ||
      (row.status === 'not_found' && age > RETRY_NOT_FOUND_AFTER_MS);
    if (stale) enqueue(pin);
  }
  return { coords: out, pending: queued.size };
};

function enqueue(pin) {
  if (queued.has(pin)) return;
  queued.add(pin);
  queue.push(pin);
  if (!draining) drain();
}

async function drain() {
  draining = true;
  try {
    while (queue.length) {
      const pin = queue.shift();
      try {
        await lookup(pin);
      } catch (err) {
        console.error(`geocode ${pin} failed:`, err.message);
      } finally {
        queued.delete(pin);
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    draining = false;
  }
}

// Every Nominatim call — background queue or an on-demand lookup — waits its
// turn here, so the 1 request/second policy holds across both.
let lastCallAt = 0;
let turn = Promise.resolve();
const waitTurn = () => {
  const mine = turn.then(async () => {
    const wait = lastCallAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  turn = mine.catch(() => {});
  return mine;
};

/// Coordinates for one pincode now (cache first, else a live lookup that
/// respects the rate limit). Used by the booking distance check.
/// Returns { lat, lng, label, district } or null when not found.
export const coordsForPincodeNow = async (pin) => {
  if (!/^[1-9]\d{5}$/.test(String(pin))) return null;
  const cached = await GeoCache.findOne({ key: pinKey(pin) }).lean();
  if (cached?.status === 'ok' && cached.lat != null && cached.lng != null) {
    return { lat: cached.lat, lng: cached.lng, label: cached.label, district: cached.district };
  }
  await lookup(pin);
  const row = await GeoCache.findOne({ key: pinKey(pin) }).lean();
  return row?.status === 'ok' && row.lat != null
    ? { lat: row.lat, lng: row.lng, label: row.label, district: row.district }
    : null;
};

/// Coordinates for a free-text address / venue now (OpenStreetMap search,
/// India only, same rate limit). Not cached — addresses are client data.
/// Returns { lat, lng, label, precise } or null. `precise` is false for
/// whole-state / country hits, which would give a meaningless distance.
export const coordsForAddressNow = async (text) => {
  const q = String(text || '').trim();
  if (q.length < 4) return null;
  await waitTurn();
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&countrycodes=in&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const hit = (await res.json())?.[0];
  if (!hit) return null;
  return {
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    label: String(hit.display_name || '').split(',').slice(0, 3).join(',').trim(),
    precise: !['country', 'state', 'state_district'].includes(hit.addresstype),
  };
};

async function lookup(pin) {
  await waitTurn();
  const url = `${NOMINATIM}?postalcode=${pin}&country=India&format=json&addressdetails=1&limit=1`;
  let status = 'ok';
  let doc = {};
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    const hit = Array.isArray(hits) ? hits[0] : null;
    if (!hit) {
      status = 'not_found';
    } else {
      const a = hit.address || {};
      doc = {
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        label:
          a.suburb || a.town || a.village || a.city || a.hamlet ||
          a.city_district || a.county || '',
        district: a.state_district || a.county || '',
      };
    }
  } catch (err) {
    status = 'error';
    console.error(`geocode ${pin}:`, err.message);
  }
  await GeoCache.updateOne(
    { key: pinKey(pin) },
    { $set: { status, ...doc }, $inc: { attempts: 1 } },
    { upsert: true }
  );
}

/// How many lookups are waiting (for the "locating N places…" hint).
export const pendingGeocodes = () => queued.size;
