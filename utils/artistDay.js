// An artist's day: their works in time order, and the road from each work to the next.
//
// An artist with several works in a day goes from one venue straight to the next
// (not back to the studio in between), so the figure that matters on their works
// screen is the distance from THIS work to the NEXT one:
//
//   work 1 ──12.4 km──▶ work 2 ──8.0 km──▶ work 3        (the last work has no "next")
//
// Pure functions: the map lookups are passed in (`placeOf`, `legOf`), so the rules
// are tested with exact numbers — tests/artistDay.test.js. The real lookups
// (OpenStreetMap + OpenRouteService) live in services/artistDay.js.

const round1 = (n) => Math.round(n * 10) / 10;

const sameSpot = (a, b) =>
  a && b && Math.abs(a.lat - b.lat) < 0.00005 && Math.abs(a.lng - b.lng) < 0.00005; // ≈ 5 m

/// Earliest start first; the id breaks a tie so the order never depends on the database.
export const inTimeOrder = (works) =>
  [...(works || [])].sort(
    (a, b) => new Date(a.serviceStart) - new Date(b.serviceStart) || String(a.id).localeCompare(String(b.id)),
  );

/**
 * @param {object}   o
 * @param {Array}    o.works    [{ id, label, serviceStart }] — any order
 * @param {Function} o.placeOf  async (work) → { lat, lng, label, approximate? } | null
 * @param {Function} o.legOf    async (fromPoint, toPoint) → { km, durationMin }
 * @returns {{ order: string[], legs: Array, warnings: string[] }}
 *   `order`  the work ids in time order
 *   `legs`   one per consecutive pair: { fromId, toId, km, durationMin, approximate, note }
 *            km is null when the road could not be measured (no location, or the map failed);
 *            `approximate` when a venue is only known to its pincode area.
 */
export const planArtistLegs = async ({ works, placeOf, legOf }) => {
  const ordered = inTimeOrder(works);
  const warnings = [];

  const places = [];
  for (const w of ordered) {
    let place = null;
    try {
      place = (await placeOf(w)) || null;
    } catch (e) {
      warnings.push(`${w.label}: couldn't look up the location (${e.message}).`);
    }
    if (!place) warnings.push(`${w.label}: location not found.`);
    places.push(place);
  }

  const legs = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const [a, b] = [places[i], places[i + 1]];
    const leg = { fromId: ordered[i].id, toId: ordered[i + 1].id, km: null, durationMin: 0, approximate: true, note: '' };
    if (!a || !b) {
      leg.note = 'location_missing';
    } else if (sameSpot(a, b)) {
      Object.assign(leg, { km: 0, durationMin: 0, approximate: !!(a.approximate || b.approximate), note: 'same_place' });
    } else {
      try {
        const r = await legOf(a, b);
        if (r && Number.isFinite(r.km)) {
          Object.assign(leg, { km: round1(r.km), durationMin: Math.round(r.durationMin || 0), approximate: !!(a.approximate || b.approximate) });
        } else {
          leg.note = 'not_measured';
        }
      } catch (e) {
        leg.note = 'not_measured';
        warnings.push(`${ordered[i].label} → ${ordered[i + 1].label}: couldn't measure the road distance (${e.message}).`);
      }
    }
    legs.push(leg);
  }

  return { order: ordered.map((w) => w.id), legs, warnings };
};

/// Everything the legs depend on. If it is unchanged since the last calculation the
/// stored legs are still right and the map services are not asked again.
export const artistDaySignature = ({ works }) =>
  inTimeOrder(works)
    .map((w) => [w.id, new Date(w.serviceStart).toISOString(), w.mapUrl || '', w.address || '', w.pincode || ''].join('|'))
    .join(';');

/**
 * What the works screen shows for one work of the day.
 * @param {string[]} order   work ids in time order (from planArtistLegs)
 * @param {Array}    legs    from planArtistLegs
 * @returns {Map<string, { position: number, total: number, nextId: string|null, leg: object|null }>}
 */
export const positionsInDay = (order, legs) => {
  const byFrom = new Map((legs || []).map((l) => [l.fromId, l]));
  return new Map(
    order.map((id, i) => [
      id,
      { position: i + 1, total: order.length, nextId: order[i + 1] ?? null, leg: byFrom.get(id) ?? null },
    ]),
  );
};
