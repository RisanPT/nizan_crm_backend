// Pure rules for the geography on a LEAD (services/leadGeography.js does the database part).
//
// A lead can carry an optional pincode and an optional district. What is stored is always
// consistent: the district (and with it the region and both names) is worked out here and on the
// server, never taken from the client — so a lead's pincode, district and region cannot disagree
// with our geography list.
//
// Precedence: a district the user chose wins; otherwise the district our pincode list gives the
// pincode; otherwise none.

import { isValidPincode, normalizePincode } from './pincodeLookup.js';

/// Keys the client must not decide: the region and the names are derived from the district.
export const DERIVED_KEYS = ['regionId', 'region', 'district'];

/// The pincode in a request body.
///   { present: false }                 — not sent: leave the lead's pincode alone
///   { present: true, code: '' }        — sent empty: clear it
///   { present: true, code: '673001' }  — sent and valid
///   { present: true, error: '…' }      — sent but not a pincode
export const readPincodeInput = (body) => {
  if (!body || !('pincode' in body)) return { present: false };
  const raw = body.pincode;
  if (raw == null || String(raw).trim() === '') return { present: true, code: '' };
  const code = normalizePincode(raw);
  if (!isValidPincode(code)) return { present: true, error: 'Enter a 6-digit pincode.' };
  return { present: true, code };
};

/// The district in a request body: { present, id } — id '' when sent empty (no explicit district).
export const readDistrictInput = (body) => {
  if (!body || !('districtId' in body)) return { present: false, id: '' };
  const raw = body.districtId;
  return { present: true, id: raw == null ? '' : String(raw).trim() };
};

/// The lead's geography fields for a district (a District with its `region` populated);
/// all cleared when there is none.
export const geographyFields = (district) => ({
  districtId: district?._id ?? null,
  regionId: district?.region?._id ?? null,
  district: district?.name ? String(district.name) : '',
  region: district?.region?.name ? String(district.region.name) : '',
});
