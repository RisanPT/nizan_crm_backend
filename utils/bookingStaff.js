// WHO WORKS A BOOKING — the assignedStaff lists (pure; tests/bookingStaff.test.js). Moved here from controllers/bookingController.js so
// the artist allocation (utils/artistAllocation.js, services/artistAllocation.js) reads and writes staff exactly as a booking save does.
//
// A booking with packages (bookingItems) keeps its team on each package; the booking-level assignedStaff is the de-duplicated merge
// of the packages' (summarizeAssignedStaff) — so staff is always WRITTEN on the package, never only on the booking.

export const normalizeWorks = (works, fallbackSpecialization = '') => {
  if (Array.isArray(works)) {
    return [
      ...new Set(
        works
          .map((item) => String(item ?? '').trim())
          .filter(Boolean)
      ),
    ];
  }

  const normalizedFallback = String(fallbackSpecialization ?? '').trim();
  return normalizedFallback ? [normalizedFallback] : [];
};

export const normalizeAssignedStaff = (assignedStaff = []) => {
  if (!Array.isArray(assignedStaff)) return [];

  return assignedStaff
    .filter((item) => item && item.employeeId)
    .map((item) => {
      const normalizedWorks = normalizeWorks(
        item.works,
        item.specialization ?? item.role
      );
      const normalizedSpecialization =
        String(item.specialization ?? '').trim() ||
        normalizedWorks[0] ||
        String(item.role ?? '').trim();

      return {
        employeeId: item.employeeId,
        artistName: item.artistName ?? '',
        role: item.role ?? normalizedSpecialization,
        specialization: normalizedSpecialization,
        works: normalizedWorks,
        phone: item.phone ?? '',
        type: item.type ?? '',
        roleType: item.roleType ?? 'assistant',
      };
    });
};

export const summarizeAssignedStaff = (bookingItems = [], fallbackAssignedStaff = []) => {
  if (!Array.isArray(bookingItems) || bookingItems.length === 0) {
    return normalizeAssignedStaff(fallbackAssignedStaff);
  }

  const mergedAssignments = [];
  const seen = new Set();

  for (const item of bookingItems) {
    for (const assignment of normalizeAssignedStaff(item?.assignedStaff ?? [])) {
      const key =
        String(assignment.employeeId ?? '').trim() ||
        `${String(assignment.artistName ?? '').trim()}::${String(assignment.roleType ?? '').trim()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      mergedAssignments.push(assignment);
    }
  }

  return mergedAssignments;
};

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/** The packages of a booking as allocation units: 'b' (a booking with no packages) or 'i:<index>' → its staff (normalized). */
export const staffByUnit = (booking) => {
  const items = Array.isArray(booking?.bookingItems) ? booking.bookingItems : [];
  const out = new Map();
  if (items.length === 0) {
    out.set('b', normalizeAssignedStaff(booking?.assignedStaff ?? []));
    return out;
  }
  items.forEach((item, i) => {
    const own = normalizeAssignedStaff(item?.assignedStaff ?? []);
    // a package with no team of its own falls back to the booking's (older bookings kept staff on the booking only)
    out.set(`i:${i}`, own.length ? own : normalizeAssignedStaff(booking?.assignedStaff ?? []));
  });
  return out;
};

/** The lead of a staff list (roleType lead), or null. */
export const leadOf = (staff) => (staff ?? []).find((s) => s?.roleType === 'lead') ?? null;

const entryFor = (employee, roleType) => ({
  employeeId: employee._id ?? employee.id,
  artistName: employee.name ?? '',
  role: roleType === 'lead' ? 'Lead Artist' : 'Assistant',
  specialization: String(employee.specialization ?? '').trim() || (roleType === 'lead' ? 'Lead Artist' : 'Assistant'),
  works: normalizeWorks(employee.works, employee.specialization),
  phone: employee.phone ?? '',
  type: employee.type ?? '',
  roleType,
});

/**
 * A package's staff with a TEAM put on it: [lead] becomes the lead, [assistants] the assistants; the driver(s) and any associate
 * (outsource) people already on it stay. [associateIds] — ids of associates (kept as they are).
 */
export const withTeamStaff = (existing, { lead, assistants = [] }, { associateIds = [] } = {}) => {
  const keepAssoc = new Set(associateIds.map(String));
  const kept = normalizeAssignedStaff(existing ?? []).filter((s) => s.roleType === 'driver' || keepAssoc.has(idOf(s.employeeId)));
  const keptIds = new Set(kept.map((s) => idOf(s.employeeId)));
  const team = [entryFor(lead, 'lead'), ...assistants.map((a) => entryFor(a, 'assistant'))].filter((s) => !keptIds.has(idOf(s.employeeId)));
  const seen = new Set();
  return [...team, ...kept].filter((s) => {
    const k = idOf(s.employeeId);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
