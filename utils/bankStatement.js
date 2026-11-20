// The STATEMENT of one bank / cash account (Finance → Bank & Cash Balance → transactions).
// Pure — tests/bankStatement.test.js. The database half is in controllers/bankAccountController.js
// and the "what was this payment for" half in services/bankTransactionDetails.js.
//
// How a balance is known: the team enters the closing balance they see in the bank (or count in the
// cash box) for a day — a "manual balance". From the next day on, every receipt and payment posted to
// the account's ledger moves it. So the balance after any transaction is
//     the manual balance in force at that time  +  receipts − payments since its day.
// A transaction dated before the first manual balance has no known balance (null) — the app shows "—".

import { isDay, istDayKey, istEnd, istStart, parseDayParam } from './istDate.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export class StatementError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/// The last instant a manual balance covers: the end of its IST day. Movements count from the next day on.
export const cutoffOf = (asOf) => (asOf ? istEnd(istDayKey(asOf)) : null);

/**
 * The manual balances in force over time, oldest first: [{ balance, asOf, cutoff }].
 * `account.balance / asOf` is the one in force NOW (the last one entered). An older entry dated after it
 * was replaced when the current one was entered, so it no longer counts. Two entries for the same day:
 * the one entered last wins. An account with no as-of date counts every movement from the beginning.
 */
export const anchorsOf = (account) => {
  if (!account.asOf) return [{ balance: round2(account.balance), asOf: null, cutoff: new Date(0) }];
  const current = { balance: round2(account.balance), asOf: account.asOf, cutoff: cutoffOf(account.asOf) };
  const byDay = new Map();
  for (const h of account.history ?? []) {
    if (!h?.asOf) continue;
    const cutoff = cutoffOf(h.asOf);
    if (cutoff >= current.cutoff) continue; // replaced by (or the same day as) the balance in force now
    byDay.set(cutoff.getTime(), { balance: round2(h.balance), asOf: h.asOf, cutoff }); // later entry for a day wins
  }
  return [...[...byDay.values()].sort((a, b) => a.cutoff - b.cutoff), current];
};

/// The manual balance in force at instant [at] — null when none had been entered by then.
export const anchorAt = (anchors, at) => {
  let found = null;
  for (const a of anchors) if (a.cutoff <= at) found = a;
  return found;
};

/**
 * The balance after each ledger line. [lines] oldest first, each { date, in, out }. Returns the same
 * lines with `balance` (null before the first manual balance).
 */
export const withRunningBalance = (anchors, lines) => {
  let ai = -1;
  let running = null;
  return lines.map((l) => {
    while (ai + 1 < anchors.length && anchors[ai + 1].cutoff < l.date) {
      ai += 1;
      running = anchors[ai].balance;
    }
    if (running !== null) running = round2(running + (l.in || 0) - (l.out || 0));
    return { ...l, balance: running };
  });
};

/// The balance at instant [at], from the lines up to it (oldest first). Null before the first manual balance.
export const balanceAt = (anchors, lines, at) => {
  const anchor = anchorAt(anchors, at);
  if (!anchor) return null;
  let b = anchor.balance;
  for (const l of lines) if (l.date > anchor.cutoff && l.date <= at) b += (l.in || 0) - (l.out || 0);
  return round2(b);
};

// ── what to show ────────────────────────────────────────────────────────────

const DIRECTIONS = ['in', 'out'];

/**
 * Reads the request. Everything is optional:
 *   from, to    'YYYY-MM-DD' (IST, inclusive). Neither = "since the last manual balance" (what makes up
 *               the live balance).
 *   direction   in | out
 *   group       a category key from the response's facets (e.g. 'artist_expense:food')
 *   person      a person key from the facets
 *   search      free text
 *   page, limit a page (newest first). export=1 = every match.
 * @throws {StatementError}
 */
export const parseStatementQuery = (q = {}) => {
  const day = (v, name) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const d = parseDayParam(String(v).trim());
    if (!d || !isDay(d)) throw new StatementError(`${name} must be a day (YYYY-MM-DD).`);
    return d;
  };
  const from = day(q.from, 'From');
  const to = day(q.to, 'To');
  if (from && to && from > to) throw new StatementError('The "from" date is after the "to" date.');
  const direction = String(q.direction ?? '').trim().toLowerCase();
  if (direction && !DIRECTIONS.includes(direction)) throw new StatementError('direction must be "in" or "out".');
  const isExport = String(q.export ?? '') === '1';
  const paged = q.page !== undefined || q.limit !== undefined;
  return {
    from,
    to,
    direction: direction || null,
    group: String(q.group ?? '').trim() || null,
    person: String(q.person ?? '').trim() || null,
    search: String(q.search ?? '').trim(),
    export: isExport,
    paged,
    page: Math.max(1, Number.parseInt(q.page, 10) || 1),
    limit: Math.min(100, Math.max(1, Number.parseInt(q.limit, 10) || 25)),
    // an older app sends nothing at all and expects every row, oldest first
    legacy: !paged && !isExport,
  };
};

/// The instants the request covers: { start (inclusive) | null, end (inclusive) | null }.
export const rangeOf = (query) => ({
  start: query.from ? istStart(query.from) : null,
  end: query.to ? istEnd(query.to) : null,
});

const text = (v) => String(v ?? '').toLowerCase();

/// Does [row] match the filters? (The dates are applied when the rows are loaded.)
export const matchesRow = (row, { direction, group, person, search }) => {
  if (direction === 'in' && !(row.in > 0)) return false;
  if (direction === 'out' && !(row.out > 0)) return false;
  if (group && row.group !== group) return false;
  if (person && row.personKey !== person) return false;
  const q = text(search).trim();
  if (q) {
    const hay = [
      row.particulars, row.title, row.subtitle, row.voucherNo, row.narration, row.client, row.bookingNumber,
      row.person?.name, row.notes, row.reference, row.categoryLabel, row.kindLabel,
      String(row.in || row.out || ''),
    ].map(text).join(' \u0001 ');
    if (!hay.includes(q)) return false;
  }
  return true;
};

/// Money in, money out and the count of [rows].
export const totalsOf = (rows) => {
  let inSum = 0;
  let outSum = 0;
  for (const r of rows) {
    inSum += r.in || 0;
    outSum += r.out || 0;
  }
  return { in: round2(inSum), out: round2(outSum), net: round2(inSum - outSum), count: rows.length };
};

/// What the list can be narrowed to: the categories and the people that appear in [rows], busiest first.
export const facetsOf = (rows) => {
  const groups = new Map();
  const people = new Map();
  for (const r of rows) {
    if (r.group) {
      const g = groups.get(r.group) ?? { key: r.group, label: r.groupLabel || r.group, count: 0 };
      g.count += 1;
      groups.set(r.group, g);
    }
    if (r.personKey) {
      const p = people.get(r.personKey) ?? { key: r.personKey, name: r.person?.name || '', role: r.person?.role || '', count: 0 };
      p.count += 1;
      people.set(r.personKey, p);
    }
  }
  const busiest = (a, b) => b.count - a.count || String(a.label ?? a.name).localeCompare(String(b.label ?? b.name));
  return { groups: [...groups.values()].sort(busiest), people: [...people.values()].sort(busiest) };
};

/// One page of [rows] (already in the order to show).
export const pageOf = (rows, page, limit) => {
  const totalItems = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  return { items: rows.slice((page - 1) * limit, page * limit), page, limit, totalItems, totalPages };
};
