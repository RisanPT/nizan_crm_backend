// Who is working a booking: the lead artist(s) and assistants, from the booking's
// own assignments and those on its per-package items. The driver, who is listed in
// the same array with roleType 'driver', is not an artist.
//
// Pure — tests/workArtists.test.js.

const ORDER = { lead: 0, assistant: 1 };

/**
 * @param {object} booking { assignedStaff: [...], bookingItems: [{ assignedStaff: [...] }] }
 * @returns {Array<{ employeeId: string, name: string, roleType: 'lead'|'assistant' }>}
 *          each person once (a lead beats an assistant listing), leads first
 */
export const artistsOf = (booking) => {
  const byId = new Map();
  const add = (list) => {
    for (const s of list || []) {
      if (!s?.employeeId || s.roleType === 'driver') continue;
      const id = String(s.employeeId);
      const roleType = s.roleType === 'lead' ? 'lead' : 'assistant';
      const prev = byId.get(id);
      if (!prev) byId.set(id, { employeeId: id, name: String(s.artistName ?? '').trim(), roleType });
      else if (roleType === 'lead') prev.roleType = 'lead';
      if (prev && !prev.name && s.artistName) prev.name = String(s.artistName).trim();
    }
  };
  add(booking?.assignedStaff);
  for (const item of booking?.bookingItems || []) add(item?.assignedStaff);
  // Array.sort is stable: within a role, the order they were assigned in is kept.
  return [...byId.values()].sort((a, b) => ORDER[a.roleType] - ORDER[b.roleType]);
};
