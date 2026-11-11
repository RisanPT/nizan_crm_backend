// Vehicle categories — the single source of truth for the fleet. The CRM's
// Dart copy (lib/features/fleet/data/vehicle_categories.dart) mirrors this list;
// keep the two in step.
//
// `seats` = passengers the vehicle takes BESIDES the driver. It is only the
// default: each vehicle stores its own `seats`, so a particular car can be
// corrected without touching this file.

export const VEHICLE_CATEGORIES = [
  { key: 'hatchback', label: 'Hatchback', seats: 4 },
  { key: 'sedan', label: 'Sedan / Taxi', seats: 4 },
  { key: 'suv', label: 'SUV', seats: 4 },
  { key: 'xl', label: 'XL (Innova / Ertiga type)', seats: 6 },
  { key: 'mpv', label: 'MPV', seats: 7 },
  { key: 'tempo_traveller', label: 'Tempo Traveller', seats: 12 },
  { key: 'bike', label: 'Bike', seats: 1 },
  { key: 'other', label: 'Other', seats: 0 },
];

export const CATEGORY_KEYS = VEHICLE_CATEGORIES.map((c) => c.key);

export const categoryByKey = (key) => VEHICLE_CATEGORIES.find((c) => c.key === key) ?? null;

export const defaultSeatsFor = (key) => categoryByKey(key)?.seats ?? 0;

// The sizes we recommend for a team, smallest first. (Hatchback / SUV / bike are
// valid vehicles to own, but a team is matched to one of these.)
const SUGGEST_ORDER = ['sedan', 'xl', 'mpv', 'tempo_traveller'];

/// The smallest recommended category that takes `people` passengers (the artists
/// and assistants going to the work — the driver is not counted).
/// `needsMultiple` is true when even the largest vehicle is too small.
export const suggestCategory = (people) => {
  const n = Math.max(0, Math.floor(Number(people) || 0));
  for (const key of SUGGEST_ORDER) {
    if (defaultSeatsFor(key) >= n) return { key, label: categoryByKey(key).label, needsMultiple: false };
  }
  const last = SUGGEST_ORDER[SUGGEST_ORDER.length - 1];
  return { key: last, label: categoryByKey(last).label, needsMultiple: true };
};

/// Does a vehicle with `seats` passenger seats take `people`?  null = its
/// capacity isn't recorded, so we can't say.
export const seatsFit = (seats, people) => {
  const s = Number(seats) || 0;
  if (s <= 0) return null;
  return s >= Math.max(0, Math.floor(Number(people) || 0));
};
