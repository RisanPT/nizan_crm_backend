// Google "Plus Codes" (Open Location Code) — the location codes Google Maps
// prints in addresses, e.g. "9RC7+WMP Sree Mookambika". Implements the open
// spec (github.com/google/open-location-code) offline: decode a full code,
// or recover a short code ("9RC7+WMP") using a nearby reference point.

const ALPHABET = '23456789CFGHJMPQRVWX';
const PAIR_RES = [20, 1, 0.05, 0.0025, 0.000125];
const GRID_ROWS = 5;
const GRID_COLS = 4;

const clean = (code) => String(code || '').toUpperCase().replace(/\s+/g, '');

/// A short ("9RC7+WMP") or full ("7J4V9RC7+WMP") plus code inside free text.
export const findPlusCode = (text) => {
  const s = String(text || '').toUpperCase();
  // In pasted links "+" often arrives as a space: "9RC7 WMP".
  const m = /(?:^|[^0-9A-Z])((?:[23456789CFGHJMPQRVWX]{2}){1,4})[+ ]([23456789CFGHJMPQRVWX]{2,3})(?![0-9A-Z])/.exec(s);
  return m ? `${m[1]}+${m[2]}` : '';
};

/// Centre of a FULL code (8 digits before "+"). Null if invalid.
export const decodeFull = (code) => {
  const c = clean(code);
  const plus = c.indexOf('+');
  if (plus !== 8) return null;
  const digits = c.replace('+', '');
  let lat = -90;
  let lng = -180;
  let latRes = 20;
  let lngRes = 20;
  const pairs = digits.slice(0, 10);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = ALPHABET.indexOf(pairs[i]);
    const b = ALPHABET.indexOf(pairs[i + 1]);
    if (a < 0 || b < 0) return null;
    const res = PAIR_RES[i / 2];
    lat += a * res;
    lng += b * res;
    latRes = res;
    lngRes = res;
  }
  // Optional 11th+ characters: 5 x 4 grid refinement.
  for (const ch of digits.slice(10)) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return null;
    latRes /= GRID_ROWS;
    lngRes /= GRID_COLS;
    lat += Math.floor(d / GRID_COLS) * latRes;
    lng += (d % GRID_COLS) * lngRes;
  }
  return { lat: lat + latRes / 2, lng: lng + lngRes / 2 };
};

// First [len] characters of the full code for a point (len is even, ≤ 8).
const encodePrefix = (lat, lng, len) => {
  let latV = Math.min(Math.max(lat, -90), 89.9999999) + 90;
  let lngV = (((lng + 180) % 360) + 360) % 360;
  let out = '';
  for (let i = 0; i < len / 2; i += 1) {
    const res = PAIR_RES[i];
    const a = Math.floor(latV / res);
    const b = Math.floor(lngV / res);
    out += ALPHABET[a] + ALPHABET[b];
    latV -= a * res;
    lngV -= b * res;
  }
  return out;
};

/// Exact point for a short or full plus code; short codes need a reference
/// point within ~50 km (e.g. the pincode's location). Null if invalid.
export const plusCodeToPoint = (code, ref) => {
  const c = clean(code);
  const plus = c.indexOf('+');
  if (plus === 8) return decodeFull(c);
  if (plus < 2 || plus > 8 || plus % 2 !== 0 || !ref) return null;
  const padding = 8 - plus;
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  const area = decodeFull(encodePrefix(ref.lat, ref.lng, padding) + c);
  if (!area) return null;
  let { lat, lng } = area;
  // Choose the copy of the code nearest the reference (spec: recoverNearest).
  if (ref.lat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (ref.lat - half > lat && lat + resolution <= 90) lat += resolution;
  if (ref.lng + half < lng) lng -= resolution;
  else if (ref.lng - half > lng) lng += resolution;
  return { lat, lng };
};
