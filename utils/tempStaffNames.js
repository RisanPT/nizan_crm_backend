// THE OLD "TEMPORARY STAFF FOR THIS BOOKING" BOX → ASSOCIATES.
//
// Before associates existed, Operations typed the outside artists who worked a bride's event into one free-text box on the booking
// (Booking.temporaryStaffDetails): "reem", "hiba & thasliya", "ajila saree drapist", "siniya (makeup) and reshma(saree)". Those works have
// to reach the Associate Works report, which only knows REGISTERED people on a booking's team. This file reads that text. Pure — no
// database (tests/tempStaffNames.test.js).
//
//  • One text holds one or more NAMES, separated by `&`, `and`, `+`, `/`, `,`, `;` or a new line. Inside a name's part, role words
//    ("saree", "drapist", "makeup", "hair") are taken out and kept as a ROLE hint; filler ("for 1st look", "the") and phone numbers are
//    taken out too. A role that ends the whole text ("hiba and akhila drapist") belongs to every name before it.
//  • The same person is typed many ways (thesliya / thasliya / thesliaya). A KEY is the name's letters alone, lower-cased, so only
//    "Moni Chechi" and "monichechi" are one key. Anything fuzzier is only SUGGESTED (similarKeys) — a person decides, because shahana,
//    shahada and shabana may well be three people.
//  • Nothing here changes data. The conversion (controllers/tempStaffController.js) applies what a person confirmed.

export const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'lost']);

const ROLE_TOKENS = [
  [/^(saree|sari|sarees|drap\w*)$/i, 'Saree draping'],
  [/^(makeup|mua)$/i, 'Makeup'],
  [/^(hair|hairstylist|hairdo)$/i, 'Hair'],
];
const IGNORED_TOKENS = /^(artist|artists|assistant|assistants|assist|helper|helpers|stylist|for|the|look|looks|st|nd|rd|th|a|an|of|to|is|are|as|with|need|needed|needs|require|required|staff|staffs|people|person|persons|nil|none|no|na|n\/a|yes|tbd|extra|additional)$/i;

/** A name's key: its letters (and the marks that belong to them, in Malayalam and the like) only, lower-cased ("Moni Chechi" and "monichechi" are one key). */
export const keyOf = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{M}]+/gu, '');

const titleCase = (s) => s.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

/** How many single-letter edits turn [a] into [b]. */
export const editDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

/** Two keys that differ by one letter (and are long enough that one letter is a typo, not a different short name). */
export const looksLikeSame = (a, b) => a !== b && Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1;

/**
 * Read one text into the people in it, each once.
 * @returns {{ key: string, name: string, role: string, phone: string }[]}  role is '' when the text names none
 */
export const parseTempStaff = (text) => {
  const raw = String(text ?? '').replace(/make\s*-?\s*up/gi, 'makeup').replace(/[()[\]{}]/g, ' ');
  const parts = raw.split(/\r?\n|;|,|&|\+|\/|\band\b/i);
  const found = [];
  for (const part of parts) {
    let role = '';
    let phone = '';
    const words = [];
    for (const tok of part.split(/\s+/).filter(Boolean)) {
      const digits = tok.replace(/\D/g, '');
      if (digits.length >= 10) { phone ||= digits; continue; }
      const roleHit = ROLE_TOKENS.find(([re]) => re.test(tok.replace(/[^\p{L}\p{M}]/gu, '')));
      if (roleHit) { role ||= roleHit[1]; continue; }
      if (IGNORED_TOKENS.test(tok) || /^\d+(st|nd|rd|th)?$/i.test(tok)) continue;
      const letters = tok.replace(/[^\p{L}\p{M}'.-]/gu, '');
      if (letters) words.push(letters);
    }
    const name = words.join(' ').replace(/\s+/g, ' ').trim();
    const key = keyOf(name);
    if (key.length < 2) continue;
    found.push({ key, name: titleCase(name), role, phone });
  }
  // a role that ends the whole text ("hiba and akhila drapist") is every name's before it
  const last = found[found.length - 1];
  if (last?.role) for (const f of found) f.role ||= last.role;
  const seen = new Set();
  return found.filter((f) => !seen.has(f.key) && seen.add(f.key));
};

const day = (b) => {
  const d = (b.selectedDates ?? [])[0] ?? b.serviceStart;
  return d ? new Date(d).toISOString().slice(0, 10) : '';
};

/** Does this booking still have temporary-staff text to look at? Not when the work is dead, the box is blank, or this exact text was already converted. */
export const isPending = (b) => {
  const text = String(b.temporaryStaffDetails ?? '');
  if (!/\S/.test(text)) return false;
  if (DEAD_STATUSES.has(String(b.status ?? '').toLowerCase())) return false;
  return !(b.tempStaffConverted && b.tempStaffConverted.text === text);
};

/**
 * The review list: one row per person (key) across all the pending bookings.
 * @param bookings   lean bookings with temporaryStaffDetails (+ tempStaffConverted, status, bookingNumber, customerName, selectedDates)
 * @param associates registered associates ({ _id, name }) — a row that is the same person as one is suggested as a link
 */
export const buildRows = (bookings, associates = []) => {
  // a text that names nobody ("2 assistants needed") has nothing to convert, so it is never counted or offered
  const pending = bookings.filter((b) => isPending(b) && parseTempStaff(b.temporaryStaffDetails).length);
  const byKey = new Map();
  for (const b of pending) {
    const text = String(b.temporaryStaffDetails);
    for (const p of parseTempStaff(text)) {
      let row = byKey.get(p.key);
      if (!row) { row = { key: p.key, variants: new Map(), roles: new Map(), phone: '', bookings: [] }; byKey.set(p.key, row); }
      row.variants.set(p.name, (row.variants.get(p.name) ?? 0) + 1);
      if (p.role) row.roles.set(p.role, (row.roles.get(p.role) ?? 0) + 1);
      row.phone ||= p.phone;
      row.bookings.push({ bookingId: String(b._id), bookingNumber: b.bookingNumber ?? '', customerName: b.customerName ?? '', day: day(b), text: text.trim().slice(0, 120) });
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  const keys = [...byKey.keys()];
  const people = associates.map((a) => ({ id: String(a._id), name: a.name, key: keyOf(a.name) }));
  const rows = keys.map((key) => {
    const r = byKey.get(key);
    const same = people.find((a) => a.key === key) ?? people.find((a) => looksLikeSame(a.key, key));
    return {
      key,
      name: top(r.variants),
      variants: [...r.variants.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      roleHint: top(r.roles),
      phone: r.phone,
      count: r.bookings.length,
      samples: r.bookings.slice(0, 3),
      similar: keys.filter((k) => looksLikeSame(k, key)),
      suggestion: same ? { employeeId: same.id, name: same.name, exact: same.key === key } : null,
    };
  });
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { pendingBookings: pending.length, rows };
};
