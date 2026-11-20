// The rows of the FINANCE REPORT (Artist Finance → Reports; CSV / Excel / PDF). Pure — tests/financeReportRows.test.js.
//
// One row per entry, collections first and then expenses, and EVERY row says which work it belongs to
// (client, booking number, the day of the work) — so an expense can be read against its work on the same line.
// A collection is tied to its booking (or trial) when it is logged. An expense is tied to a work by the artist's
// own pick, or — for food and the like — placed under the work it was eaten for by the time of the meal
// (utils/mealAllocation.js); the report asks the same question the By Work screen does, so they always agree.

import { istDayKey } from './istDate.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// '2026-11-16' → '16 Nov 2026' ('' for nothing).
export const dayText = (day) => (day ? `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}` : '');

/// How the work was decided, in words (the allocation's mode).
export const LINKED_LABELS = {
  pinned: 'Chosen by the artist',
  direct: 'Chosen by the artist',
  time: 'By time of the meal',
  single: 'Only work that day',
  last: 'Last work of the day',
  shoot: 'Model shoot',
};

export const NOT_TIED = 'Not tied to a work';

/// [header, key] of every column of the CSV and the Excel sheet, in order.
export const FINANCE_COLUMNS = [
  ['Type', 'type'],
  ['Date', 'dayText'],
  ['Artist', 'artist'],
  ['Client / Work', 'client'],
  ['Booking No.', 'bookingNo'],
  ['Work Date', 'workDayText'],
  ['Category', 'category'],
  ['Amount', 'amount'],
  ['Logged Amount', 'loggedAmount'],
  ['Status', 'status'],
  ['Work Linked', 'linked'],
  ['Notes', 'notes'],
];

const dayOf = (d) => (d ? istDayKey(d) : '');
const newestFirst = (a, b) => (b.day < a.day ? -1 : b.day > a.day ? 1 : b.sortAt - a.sortAt);
const stamp = (x) => new Date(x.createdAt ?? x.date ?? 0).getTime() || 0;

/// A booking (populated, or the allocation's version of one) as { client, bookingNo, day }.
const workInfo = (b) => ({
  client: String(b.customerName ?? '').trim() || String(b.bookingNumber ?? '').trim() || 'Work',
  bookingNo: String(b.bookingNumber ?? '').trim(),
  day: dayOf(b.serviceStart),
});

const populated = (v) => (v && typeof v === 'object' && v._id && (v.customerName !== undefined || v.bookingNumber !== undefined) ? v : null);

/**
 * @param {{ collections: object[], expenses: object[], allocation?: { byExpense: Map, bookings: Map } }} input
 *   collections: bookingId {bookingNumber, customerName, serviceStart}, trialId {trialNumber, clientName}, employeeId {name}
 *   expenses:    employeeId {name}, bookingId (optional, populated), amount, loggedAmount, …
 *   allocation:  computeAllocations(expenses) — where each expense was placed
 * @returns {{ collections: Row[], expenses: Row[] }}
 *   Row: { type, day, dayText, artist, client, bookingNo, workDays: string[], workDayText, category, amount,
 *          loggedAmount (number | null — only when the approval reduced it), status, linked, notes }
 */
export const buildFinanceRows = ({ collections = [], expenses = [], allocation = { byExpense: new Map(), bookings: new Map() } }) => {
  const collectionRows = collections.map((c) => {
    const booking = populated(c.bookingId);
    const trial = c.trialId && typeof c.trialId === 'object' ? c.trialId : null;
    const day = dayOf(c.date);
    const workDay = booking ? dayOf(booking.serviceStart) : '';
    return {
      type: 'Collection',
      day,
      dayText: dayText(day),
      sortAt: stamp(c),
      artist: c.employeeId?.name || 'Unknown',
      client: booking?.customerName || trial?.clientName || 'N/A',
      bookingNo: booking?.bookingNumber || trial?.trialNumber || '',
      workDays: workDay ? [workDay] : [],
      workDayText: dayText(workDay),
      category: '',
      amount: round2(c.amount),
      loggedAmount: null,
      status: c.status,
      linked: '',
      notes: c.notes || '',
    };
  });

  const expenseRows = expenses.map((e) => {
    const a = allocation.byExpense.get(String(e._id));
    // the works it counts under: the allocation's, else the booking the artist tied it to
    let infos = (a?.shares ?? []).map((s) => allocation.bookings.get(s.bookingId)).filter(Boolean).map(workInfo);
    let linked = infos.length ? (LINKED_LABELS[a.mode] ?? '') : '';
    if (infos.length === 0 && populated(e.bookingId)) {
      infos = [workInfo(populated(e.bookingId))];
      linked = LINKED_LABELS.pinned;
    }
    // one entry, one work in nearly every case; if it was split across works, say all of them
    const unique = (list) => [...new Set(list.filter(Boolean))];
    const clients = unique(infos.map((i) => i.client));
    const workDays = unique(infos.map((i) => i.day)).sort();
    const day = dayOf(e.date);
    const reduced = e.loggedAmount != null && round2(e.loggedAmount) !== round2(e.amount);
    return {
      type: 'Expense',
      day,
      dayText: dayText(day),
      sortAt: stamp(e),
      artist: e.employeeId?.name || 'Unknown',
      client: clients.length ? clients.join(' + ') : e.workType === 'model_shoot' ? 'Model shoot' : NOT_TIED,
      bookingNo: unique(infos.map((i) => i.bookingNo)).join(' + '),
      workDays,
      workDayText: workDays.map(dayText).join(' + '),
      category: e.category,
      amount: round2(e.amount),
      loggedAmount: reduced ? round2(e.loggedAmount) : null,
      status: e.status,
      linked: clients.length === 0 && e.workType === 'model_shoot' ? LINKED_LABELS.shoot : linked,
      notes: e.notes || '',
    };
  });

  return { collections: collectionRows.sort(newestFirst), expenses: expenseRows.sort(newestFirst) };
};

/// Totals by status, for the end of the report. A rejected entry is listed but never counts.
export const summarizeFinanceRows = ({ collections, expenses }) => {
  const sums = (rows) => {
    const s = { verified: 0, pending: 0, rejected: 0 };
    for (const r of rows) if (r.status in s) s[r.status] = round2(s[r.status] + r.amount);
    return { ...s, counted: round2(s.verified + s.pending), count: rows.length };
  };
  const c = sums(collections);
  const x = sums(expenses);
  return { collections: c, expenses: x, net: round2(c.counted - x.counted) };
};

/// A text cell that a spreadsheet will not take for a formula (entries are typed by artists): "=…", "+…", "-…", "@…".
export const csvSafe = (v) => {
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

/// One row as the plain record the CSV is made from: every column, text cells made safe.
export const csvRecord = (row) => {
  const out = {};
  for (const [header, key] of FINANCE_COLUMNS) {
    const v = row[key];
    out[header] = typeof v === 'number' ? v : v == null ? '' : csvSafe(v);
  }
  return out;
};
