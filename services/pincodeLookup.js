import Pincode from '../models/Pincode.js';
import District from '../models/District.js';
import { coordsForPincodes, coordsForPincodeNow, isKnownMissingPincode } from '../utils/geocode.js';
import { buildLookup, isValidPincode, matchDistrict, normalizePincode } from '../utils/pincodeLookup.js';

// district → region → state → zone, the whole chain a form needs in one go.
const chain = {
  path: 'district',
  populate: { path: 'region', populate: { path: 'state', populate: { path: 'zone' } } },
};

/// Everything known about one pincode: where our list puts it, and what the place lookup knows.
///
/// • In our list → answered from it at once. Coordinates come from the cache only (a pin not yet
///   cached is queued for the background lookup, so the next ask has them) — the form never waits
///   on the geocoder for a pincode we already know.
/// • Not in our list → one live place lookup (cached, rate-limited, only the pincode is sent) to
///   get its area and the district OpenStreetMap files it under; that name is matched to OUR
///   districts and offered as a suggestion.
/// A failure of the place lookup never fails the answer.
export const resolvePincode = async (rawCode) => {
  const code = normalizePincode(rawCode);
  if (!isValidPincode(code)) {
    const err = new Error('Enter a 6-digit pincode.');
    err.status = 400;
    throw err;
  }

  const master = await Pincode.findOne({ code }).populate(chain).lean();

  if (master) {
    let geo = null;
    try {
      geo = (await coordsForPincodes([code])).coords.get(code) ?? null;
    } catch (err) {
      console.error('pincode cache lookup failed:', err.message);
    }
    return buildLookup({ code, master, geo });
  }

  let geo = null;
  try {
    // A pincode the place service has already said it does not know is not asked about again.
    if (!(await isKnownMissingPincode(code))) geo = await coordsForPincodeNow(code);
  } catch (err) {
    console.error('pincode place lookup failed:', err.message);
  }
  let suggested = null;
  if (geo?.district) {
    const districts = await District.find({ status: { $ne: 'inactive' } })
      .populate({ path: 'region', populate: { path: 'state', populate: { path: 'zone' } } })
      .lean();
    suggested = matchDistrict(geo.district, districts);
  }
  return buildLookup({ code, geo, suggested });
};
