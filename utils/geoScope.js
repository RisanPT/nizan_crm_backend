import mongoose from 'mongoose';

// Territory (geo) scoping. A user with a full-access role, or with no geo set,
// sees everything. Everyone else is limited to the most specific geo level
// pinned on their login. The geo tree is:
//   Zone  ←  State.zone  ←  Region.state  ←  District.region  ←  Pincode.district
// Employee/User carry the five ids flat (zoneId … pincodeId); Booking/Lead
// store only regionId/districtId, so their scope is resolved down to regions.

const FULL_ACCESS_ROLES = ['admin', 'manager'];

export const isFullGeoAccess = (user) =>
  !user || FULL_ACCESS_ROLES.includes(String(user.role || '').toLowerCase());

// The most specific geo level the user is pinned to, or null (= all-India).
export const pinnedGeoLevel = (user) => {
  if (!user) return null;
  if (user.pincodeId) return { level: 'pincodeId', id: user.pincodeId };
  if (user.districtId) return { level: 'districtId', id: user.districtId };
  if (user.regionId) return { level: 'regionId', id: user.regionId };
  if (user.stateId) return { level: 'stateId', id: user.stateId };
  if (user.zoneId) return { level: 'zoneId', id: user.zoneId };
  return null;
};

// Match fragment for collections that store the full flat geo (Employee, User).
// Matches the user's own pinned level directly. {} = unrestricted.
export const flatGeoMatch = (user) => {
  if (isFullGeoAccess(user)) return {};
  const pin = pinnedGeoLevel(user);
  if (!pin) return {};
  return { [pin.level]: pin.id };
};

// Match fragment for collections that only store regionId/districtId
// (Booking, Lead). Resolves the user's scope down to the regions it covers.
// {} = unrestricted; { _id: { $in: [] } } = deny-all (safe) when the scope
// can't be resolved to any region.
export const regionScopedMatch = async (user) => {
  if (isFullGeoAccess(user)) return {};
  const pin = pinnedGeoLevel(user);
  if (!pin) return {};

  const Region = mongoose.model('Region');
  const State = mongoose.model('State');
  const ids = (docs) => docs.map((d) => d._id);

  if (pin.level === 'districtId') return { districtId: pin.id };
  if (pin.level === 'regionId') return { regionId: pin.id };

  if (pin.level === 'stateId') {
    const regions = await Region.find({ state: pin.id }).select('_id').lean();
    return { regionId: { $in: ids(regions) } };
  }

  if (pin.level === 'zoneId') {
    const states = await State.find({ zone: pin.id }).select('_id').lean();
    const regions = await Region.find({ state: { $in: ids(states) } }).select('_id').lean();
    return { regionId: { $in: ids(regions) } };
  }

  if (pin.level === 'pincodeId') {
    const Pincode = mongoose.model('Pincode');
    const pincode = await Pincode.findById(pin.id).select('district').lean();
    if (pincode?.district) return { districtId: pincode.district };
    return { _id: { $in: [] } };
  }

  return {};
};
