// How a driver's planned day compares with what the odometer recorded.
//
// Each completed trip's odometer (endKm − startKm) covers the way INTO that work
// (the next trip starts where the last ended), so the way back to HQ is on no
// trip. Compare like with like: the planned km WITHOUT the return leg, and show
// the return leg separately. Pure — tests/dayDistance.test.js.

const round1 = (n) => Math.round(n * 10) / 10;

/// More than this far off the plan is worth a second look.
export const TOLERANCE_PERCENT = 10;

const tripKm = (w) =>
  w.startKm != null && w.endKm != null && w.endKm >= w.startKm ? round1(w.endKm - w.startKm) : null;

/**
 * @param {object} o
 * @param {Array}  o.legs       the plan's legs [{ kind, km }] (km null = couldn't be measured)
 * @param {number} o.plannedKm  the plan's total
 * @param {string} [o.planError]
 * @param {Array}  o.works      the day's works [{ tripStatus, startKm, endKm }]
 * @returns {{ plannedKm, returnKm, plannedTrackedKm, trackedKm, allTracked, variance, estimatedDayKm, status }}
 *   status:
 *     no_works     nothing on that day to check against
 *     no_route     no usable route (not calculated, a leg couldn't be measured, or an error)
 *     in_progress  some trip isn't finished (or has no odometer reading) yet
 *     ok           the odometer is within TOLERANCE_PERCENT of the plan
 *     over / under the odometer is more / less than that
 */
export const dayDistance = ({ legs = [], plannedKm = 0, planError = '', works = [] }) => {
  let trackedKm = 0;
  let allTracked = works.length > 0;
  for (const w of works) {
    const km = tripKm(w);
    if (w.tripStatus === 'completed' && km !== null) trackedKm += km;
    else allTracked = false;
  }

  const returnKm = round1(legs.filter((l) => l.kind === 'return').reduce((s, l) => s + (l.km || 0), 0));
  const plannedTrackedKm = round1((plannedKm || 0) - returnKm);
  const measuredAll = legs.length > 0 && legs.every((l) => l.km !== null);
  const routeOk = !planError && measuredAll && plannedTrackedKm > 0;

  let variance = null;
  let status;
  if (works.length === 0) status = 'no_works';
  else if (!routeOk) status = 'no_route';
  else if (!allTracked) status = 'in_progress';
  else {
    const km = round1(trackedKm - plannedTrackedKm);
    const percent = Math.round((km / plannedTrackedKm) * 100);
    variance = { km, percent };
    status = Math.abs(percent) <= TOLERANCE_PERCENT ? 'ok' : percent > 0 ? 'over' : 'under';
  }

  return {
    plannedKm: round1(plannedKm || 0),
    returnKm,
    plannedTrackedKm,
    trackedKm: round1(trackedKm),
    allTracked,
    variance,
    // the odometer trips + the (unrecorded) way home
    estimatedDayKm: allTracked && works.length ? round1(trackedKm + returnKm) : null,
    status,
  };
};

export { tripKm };
