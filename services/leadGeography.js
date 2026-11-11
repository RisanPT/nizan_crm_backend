import mongoose from 'mongoose';
import District from '../models/District.js';
import Pincode from '../models/Pincode.js';
import { DERIVED_KEYS, geographyFields, readDistrictInput, readPincodeInput } from '../utils/leadGeography.js';

const bad = (message) => Object.assign(new Error(message), { status: 400 });

const withRegion = { path: 'region', select: 'name' };

/// Turns the pincode / districtId a client sent on a lead into consistent stored geography, in
/// place on [data] (a copy of the request body):
///   • regionId / region / district sent by the client are dropped — they are derived;
///   • neither `pincode` nor `districtId` sent → nothing else changes;
///   • otherwise `pincode` is stored cleaned, and districtId / regionId / district / region are set
///     from the chosen district, else from the district our pincode list gives the pincode, else
///     cleared (a pincode we cannot place leaves the lead without a district, never a stale one).
/// Throws an error with status 400 for a malformed pincode or an unknown district.
export const applyLeadGeography = async (data) => {
  for (const key of DERIVED_KEYS) delete data[key];

  const pin = readPincodeInput(data);
  const dist = readDistrictInput(data);
  if (!pin.present && !dist.present) return;
  if (pin.error) throw bad(pin.error);

  let district = null;
  if (dist.id) {
    if (!mongoose.isValidObjectId(dist.id)) throw bad('Choose a district from the list.');
    district = await District.findById(dist.id).populate(withRegion).lean();
    if (!district) throw bad('That district is not in the list.');
  } else if (pin.code) {
    const master = await Pincode.findOne({ code: pin.code })
      .populate({ path: 'district', populate: withRegion })
      .lean();
    district = master?.district ?? null;
  }

  if (pin.present) data.pincode = pin.code;
  delete data.districtId;
  Object.assign(data, geographyFields(district));
};
