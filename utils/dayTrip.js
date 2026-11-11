// A driver's day: how far will the vehicle go?
//
// The vehicle starts the day at the headquarters (HiLITE Business Park, Calicut)
// and goes back there at the end:
//
//   • ONE work in the day   →  HQ → work → HQ.   The way back is taken as the same
//                              distance as the way out, so the total is 2 × (HQ → work).
//   • SEVERAL works         →  HQ → 1st work → 2nd work → … → last work → HQ,
//                              the works taken in the order of their start time.
//
// Pure functions: the map lookups are passed in (`placeOf`, `legOf`), so the
// rules can be tested with exact numbers — tests/dayTrip.test.js. The real
// lookups (OpenStreetMap + OpenRouteService) live in services/dayTrip.js.

const round1 = (n) => Math.round(n * 10) / 10;

const sameSpot = (a, b) =>
  a && b && Math.abs(a.lat - b.lat) < 0.00005 && Math.abs(a.lng - b.lng) < 0.00005; // ≈ 5 m

/**
 * @param {object}   o
 * @param {Array}    o.works    [{ id, label, serviceStart, travelDistanceKm }] — any order
 * @param {object}   o.hq       { lat, lng, label }
 * @param {Function} o.placeOf  async (work) → { lat, lng, label, approximate? } | null
 * @param {Function} o.legOf    async (fromPoint, toPoint) → { km, durationMin } | null
 * @returns the plan: { rule, stops, legs, plannedKm, plannedMin, perWorkKm, approximate, warnings }
 */
export const planDay = async ({ works, hq, placeOf, legOf }) => {
  const ordered = [...(works || [])].sort(
    (a, b) => new Date(a.serviceStart) - new Date(b.serviceStart) || String(a.id).localeCompare(String(b.id)),
  );
  const warnings = [];
  const hqPoint = { lat: hq.lat, lng: hq.lng, label: hq.label };

  if (ordered.length === 0) {
    return { rule: 'none', stops: [], legs: [], plannedKm: 0, plannedMin: 0, perWorkKm: {}, approximate: false, warnings };
  }

  // Where is each work?
  const stops = [];
  for (const w of ordered) {
    let place = null;
    try {
      place = (await placeOf(w)) || null;
    } catch (e) {
      warnings.push(`${w.label}: couldn't look up the location (${e.message}).`);
    }
    if (!place) warnings.push(`${w.label}: location not found — add the map link, address or pincode.`);
    stops.push({
      bookingId: w.id,
      label: w.label,
      located: !!place,
      point: place ? { lat: place.lat, lng: place.lng, label: place.label || w.label } : null,
      approximate: !!place?.approximate,
      travelDistanceKm: Number(w.travelDistanceKm) || 0,
    });
  }

  let approximate = stops.some((s) => s.approximate) || stops.some((s) => !s.located);
  const legs = [];

  // One leg of the route. Returns km (a number) or null when it can't be measured.
  const leg = async (from, to, kind) => {
    let km = null;
    let durationMin = 0;
    if (sameSpot(from, to)) {
      km = 0;
    } else {
      try {
        const r = await legOf(from, to);
        if (r && Number.isFinite(r.km)) {
          km = r.km;
          durationMin = r.durationMin || 0;
        }
      } catch (e) {
        warnings.push(`${from.label} → ${to.label}: couldn't measure the road distance (${e.message}).`);
      }
    }
    if (km === null) approximate = true;
    legs.push({ kind, from: from.label, to: to.label, km: km === null ? null : round1(km), durationMin, mirrored: false });
    return km;
  };

  // A work with no map location can't be placed in the chain. Use its saved
  // one-way HQ distance (if any) as a separate there-and-back trip, and say so.
  const estimateDetour = (stop) => {
    const km = round1(stop.travelDistanceKm * 2);
    legs.push({ kind: 'estimate', from: hqPoint.label, to: stop.label, km, durationMin: 0, mirrored: false, note: 'no location — 2 × saved HQ distance' });
    return km;
  };

  const perWorkKm = {};
  const add = (id, km) => {
    if (km) perWorkKm[id] = round1((perWorkKm[id] || 0) + km);
  };
  for (const s of stops) perWorkKm[s.bookingId] = 0;

  let rule;
  if (stops.length === 1) {
    // ── one work: there and back, the way back = the way out ──
    rule = 'round_trip';
    const s = stops[0];
    if (s.located) {
      const out = await leg(hqPoint, s.point, 'out');
      if (out !== null) {
        legs.push({
          kind: 'return', from: s.label, to: hqPoint.label,
          km: round1(out), durationMin: legs[legs.length - 1].durationMin, mirrored: true,
        });
        add(s.bookingId, out * 2);
      }
    } else if (s.travelDistanceKm > 0) {
      add(s.bookingId, estimateDetour(s));
    }
  } else {
    // ── several works: HQ → 1st → 2nd … → last → HQ ──
    rule = 'multi_stop';
    let cursor = hqPoint;
    let cursorIsHq = true;
    let lastLocated = null;
    for (const s of stops) {
      if (!s.located) {
        if (s.travelDistanceKm > 0) add(s.bookingId, estimateDetour(s));
        continue;
      }
      const km = await leg(cursor, s.point, cursorIsHq ? 'out' : 'between');
      add(s.bookingId, km);
      cursor = s.point;
      cursorIsHq = false;
      lastLocated = s;
    }
    if (lastLocated) {
      const back = await leg(cursor, hqPoint, 'return');
      add(lastLocated.bookingId, back); // the way home belongs to the last work
    }
  }

  const plannedKm = round1(legs.reduce((sum, l) => sum + (l.km || 0), 0));
  // Time: the mirrored return leg takes as long as the way out.
  const plannedMin = Math.round(legs.reduce((sum, l) => sum + (l.durationMin || 0), 0));

  return {
    rule,
    stops: stops.map(({ bookingId, label, located, approximate: ap }) => ({ bookingId, label, located, approximate: ap })),
    legs,
    plannedKm,
    plannedMin,
    perWorkKm,
    approximate,
    warnings,
  };
};

/// A short signature of everything the plan depends on. If it's unchanged since
/// the last calculation, the stored plan is still right and the maps aren't asked.
export const daySignature = ({ works, hq }) =>
  [
    `${Number(hq.lat).toFixed(5)},${Number(hq.lng).toFixed(5)}`,
    ...[...(works || [])]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((w) => [w.id, new Date(w.serviceStart).toISOString(), w.mapUrl || '', w.address || '', w.pincode || '', w.travelDistanceKm || 0].join('|')),
  ].join(';');
