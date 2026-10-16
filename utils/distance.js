import GeoCache from '../models/GeoCache.js';
import { coordsForPincodeNow, coordsForAddressNow } from './geocode.js';
import { locationFromMapLink } from './mapLink.js';
import { findPlusCode, plusCodeToPoint } from './plusCode.js';

// Road distance from the headquarters (HiLITE Business Park, Calicut) to a
// booking's location.
//   • place: OpenStreetMap — pincode (cached, shared with the booking map) or
//     the venue address. OpenRouteService's own search doesn't know Indian
//     pincodes and misplaced venues in testing, so it isn't used for this.
//   • route: OpenRouteService driving directions (real road km + drive time).
// Each pincode's route is cached, so it's looked up once.
// The ORS key stays on the server (ORS_API_KEY in .env).

const ORS = 'https://api.openrouteservice.org';
const ROUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // roads change rarely
// A venue address is trusted over the pincode's centre only when it lands
// this close to that pincode (guards against a same-named place elsewhere).
const ADDRESS_MATCH_KM = 25;

// Read per call: server.js loads .env after its imports have run.
export const headquarters = () => ({
  lat: Number(process.env.HQ_LAT) || 11.2483,
  lng: Number(process.env.HQ_LNG) || 75.834,
  label: process.env.HQ_LABEL || 'HiLITE Business Park, Kozhikode',
});

const orsKey = () => String(process.env.ORS_API_KEY || '').trim();

export class DistanceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const straightKm = (a, b) => {
  const r = (x) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const routeFromHq = async (to) => {
  const hq = headquarters();
  const url = new URL(`${ORS}/v2/directions/driving-car`);
  url.search = new URLSearchParams({
    api_key: orsKey(),
    start: `${hq.lng},${hq.lat}`,
    end: `${to.lng},${to.lat}`,
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new DistanceError(`Route lookup failed: ${msg}`, 502);
  }
  const s = body?.features?.[0]?.properties?.summary;
  if (!s || s.distance == null) throw new DistanceError('No driving route found to this place.', 404);
  return {
    roadKm: Math.round((s.distance / 1000) * 10) / 10,
    durationMin: Math.round((s.duration || 0) / 60),
  };
};

const addressPlace = async (text) => {
  try {
    return await coordsForAddressNow(text);
  } catch (err) {
    console.error('address lookup failed:', err.message);
    return null;
  }
};

// Many Google share links carry only the venue's name + address, e.g.
// "9RC7 WMP Sree Mookambika, Kerala 673613". Tried in order:
//   1. a Plus Code in it (exact pin; short codes recovered near the pincode)
//   2. OpenStreetMap search on the full text, then on "venue, town"
//   3. the pincode's area — approximate, and labelled so
// Exact results must lie near the pincode (when there is one), so a
// same-named place elsewhere can't slip in.
const placeFromName = async (text) => {
  const hq = headquarters();
  const pins = String(text).match(/(?<!\d)[1-9]\d{5}(?!\d)/g) || [];
  const pin = pins[pins.length - 1] || '';
  const pinPlace = pin ? await coordsForPincodeNow(pin) : null;
  const nearPin = (pt) => !pinPlace || straightKm(pt, pinPlace) <= ADDRESS_MATCH_KM;

  const code = findPlusCode(text);
  if (code) {
    const pt = plusCodeToPoint(code, pinPlace || hq);
    if (pt && nearPin(pt)) return { place: pt, label: `${code} (${text.split(',')[0].replace(code.replace('+', ' '), '').trim() || 'plus code'})` };
  }

  const parts = String(text).split(',').map((x) => x.trim()).filter(Boolean);
  const town = parts.filter((x) => !/^\D*\d{6}\D*$/.test(x) && !/^kerala$/i.test(x)).slice(-1)[0] || '';
  for (const q of [text, parts.length > 1 ? `${parts[0]}, ${town}` : '']) {
    if (!q) continue;
    const found = await addressPlace(q);
    if (found?.precise && nearPin(found)) return { place: found, label: found.label };
  }

  if (pinPlace) {
    return { place: pinPlace, label: `${parts[0] || 'Venue'} — pincode ${pin} area (approx.)` };
  }
  return null;
};

const pincodeRoute = async (pin) => {
  const hq = headquarters();
  const key = `route:${pin}`;
  const cached = await GeoCache.findOne({ key }).lean();
  const fresh = cached && Date.now() - new Date(cached.updatedAt).getTime() < ROUTE_TTL_MS;
  // Moving the HQ (HQ_LAT / HQ_LNG) invalidates old routes.
  if (cached?.status === 'ok' && cached.roadKm != null && fresh && cached.origin === `${hq.lat},${hq.lng}`) {
    return { km: cached.roadKm, durationMin: cached.durationMin, to: cached.label, cached: true };
  }
  const place = await coordsForPincodeNow(pin);
  if (!place) return null;
  const route = await routeFromHq(place);
  const to = [place.label, place.district].filter(Boolean).join(', ') || pin;
  await GeoCache.updateOne(
    { key },
    { $set: { status: 'ok', lat: place.lat, lng: place.lng, label: to, origin: `${hq.lat},${hq.lng}`, ...route } },
    { upsert: true }
  );
  return { km: route.roadKm, durationMin: route.durationMin, to, cached: false, place };
};

/**
 * Road distance from the headquarters.
 * Pincode alone → that pincode. Address alone → the address (must be a real
 * place, not just a state). Both → the address when it lies within 25 km of
 * the pincode (more exact venue), otherwise the pincode.
 * @returns {{ km, durationMin, from, to, pincode, method, cached }}
 */
export const distanceFromHq = async ({ pincode, address }) => {
  if (!orsKey()) {
    throw new DistanceError('Distance is not set up yet — ORS_API_KEY is missing on the server.', 503);
  }
  const hq = headquarters();
  const pin = String(pincode || '').replace(/\D/g, '');
  const text = String(address || '').trim();
  const hasPin = /^[1-9]\d{5}$/.test(pin);

  if (!hasPin && text.length < 4) {
    throw new DistanceError('Enter a 6-digit pincode or the address to calculate the distance.');
  }

  if (hasPin) {
    const viaPin = await pincodeRoute(pin);
    if (!viaPin) throw new DistanceError(`Pincode ${pin} could not be located. Check the pincode.`, 404);
    if (text.length >= 4) {
      const venue = await addressPlace(text);
      const pinPlace = viaPin.place || (await coordsForPincodeNow(pin));
      if (venue?.precise && pinPlace && straightKm(venue, pinPlace) <= ADDRESS_MATCH_KM) {
        const route = await routeFromHq(venue);
        return { km: route.roadKm, durationMin: route.durationMin, from: hq.label, to: venue.label, pincode: pin, method: 'address', cached: false };
      }
    }
    return { km: viaPin.km, durationMin: viaPin.durationMin, from: hq.label, to: viaPin.to, pincode: pin, method: 'pincode', cached: viaPin.cached };
  }

  const venue = await addressPlace(text);
  if (!venue || !venue.precise) {
    throw new DistanceError('That address is too vague to place on the map — add the pincode for an exact distance.', 404);
  }
  const route = await routeFromHq(venue);
  return { km: route.roadKm, durationMin: route.durationMin, from: hq.label, to: venue.label, pincode: '', method: 'address', cached: false };
};

/**
 * Road distance from the headquarters to the place a pasted map link (or
 * typed "lat, lng") points at — the exact venue pin, more precise than a
 * pincode. Links that only carry a place name are looked up by that name.
 * Not cached: map links are per-booking venue data.
 * @returns {{ km, durationMin, from, to, method: 'map_link' }}
 */
export const distanceFromMapLink = async (link) => {
  if (!orsKey()) {
    throw new DistanceError('Distance is not set up yet — ORS_API_KEY is missing on the server.', 503);
  }
  let loc;
  try {
    loc = await locationFromMapLink(link);
  } catch (err) {
    console.error('map link read failed:', err.message);
    throw new DistanceError('Could not open that short map link. Open it in the browser and paste the full link from the address bar (or the coordinates).', 502);
  }
  if (!loc) {
    throw new DistanceError('No location found in that link. Paste a Google Maps link or coordinates like 11.2588, 75.7804.', 404);
  }
  let place = loc;
  let to = loc.lat != null ? `Map pin ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : '';
  if (loc.query) {
    const named = await placeFromName(loc.query);
    if (!named) {
      throw new DistanceError(`The link only names "${loc.query}" and it couldn't be placed — paste a link with the pin or the coordinates.`, 404);
    }
    place = named.place;
    to = named.label;
  }
  const route = await routeFromHq(place);
  return { km: route.roadKm, durationMin: route.durationMin, from: headquarters().label, to, method: 'map_link' };
};
