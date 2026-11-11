// Pure rules for the pincode lookup (services/pincodeLookup.js does the database + geocoding).
//
// A pincode is answered from OUR pincode list first (Pincode → District → Region → State → Zone). A
// pin that is not in the list can still be placed when the place lookup (OpenStreetMap, cached in
// GeoCache) names its district and that name matches one of OUR districts — shown as a suggestion,
// never as fact.

/// A pincode as typed → digits only ("673 001" → "673001").
export const normalizePincode = (raw) => String(raw ?? '').replace(/\D/g, '');

/// An Indian pincode: six digits, never starting with 0.
export const isValidPincode = (code) => /^[1-9]\d{5}$/.test(String(code ?? ''));

// Names the same district goes by. Keys and values are already in districtKey() form.
const ALIASES = new Map([
  ['calicut', 'kozhikode'],
  ['trivandrum', 'thiruvananthapuram'],
  ['alleppey', 'alappuzha'],
  ['palghat', 'palakkad'],
  ['cannanore', 'kannur'],
  ['quilon', 'kollam'],
  ['trichur', 'thrissur'],
  ['cochin', 'ernakulam'],
]);

/// A district name reduced for comparing: lower case, no "district", no punctuation, one spelling.
/// "Kozhikode District" and "Calicut" give the same key.
export const districtKey = (name) => {
  const k = String(name ?? '')
    .toLowerCase()
    .replace(/\bdistrict\b/g, '')
    .replace(/[^a-z]/g, '');
  return ALIASES.get(k) ?? k;
};

/// The one of [districts] ({ _id, name }) that [candidate] names — null when none match, or when
/// more than one does (two districts of the same name in different regions is not a guess to make).
export const matchDistrict = (candidate, districts) => {
  const key = districtKey(candidate);
  if (!key) return null;
  const hits = (districts ?? []).filter((d) => districtKey(d?.name) === key);
  return hits.length === 1 ? hits[0] : null;
};

const ref = (doc) => (doc && doc._id ? { id: String(doc._id), name: String(doc.name ?? '') } : null);

/// The district → region → state → zone chain of a (populated) district, as plain { id, name }s.
export const placeOfDistrict = (district) => ({
  district: ref(district),
  region: ref(district?.region),
  state: ref(district?.region?.state),
  zone: ref(district?.region?.state?.zone),
});

/// What the lookup answers.
///   source: 'master'  — the pincode is in our list
///           'geocode' — not in our list; the district is the place lookup's, matched to ours (a suggestion)
///           'none'    — nothing known beyond (maybe) the coordinates
///   active: false when our list marks the pincode inactive.
export const buildLookup = ({ code, master = null, geo = null, suggested = null }) => {
  const base = { code, valid: true, found: false, source: 'none', active: true, district: null, region: null, state: null, zone: null, area: '', lat: null, lng: null };
  if (geo) {
    base.area = String(geo.label ?? '');
    base.lat = geo.lat ?? null;
    base.lng = geo.lng ?? null;
  }
  if (master) {
    return { ...base, found: true, source: 'master', active: master.status !== 'inactive', ...placeOfDistrict(master.district) };
  }
  if (suggested) {
    return { ...base, found: true, source: 'geocode', ...placeOfDistrict(suggested) };
  }
  return base;
};
