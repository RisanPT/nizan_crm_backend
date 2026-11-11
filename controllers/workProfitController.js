import { SORTS, sortRows, summarize, THIN_MARGIN_PCT } from '../utils/workProfit.js';
import { addDays, parseDayParam, todayIst } from '../utils/istDate.js';
import { escapeRegex } from '../utils/financeListQuery.js';
import { identityOf, workProfitFor } from '../services/workProfit.js';

// Money per work is for Accounts and the owners only.
const ACCOUNTS_ROLES = new Set(['accounts', 'finance_head', 'admin', 'ceo']); // + 'ceo': read-only, enforced in middleware/ceoGuard.js
const EXPORT_CAP = 2000;
const MAX_DAYS = 366;
const FLAGS = ['loss', 'thin', 'no_costs', 'pending_costs'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/// The current IST month, as [first day, last day].
const thisMonth = () => {
  const [y, m] = todayIst().split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return [`${y}-${mm}-01`, `${y}-${mm}-${String(last).padStart(2, '0')}`];
};

// @desc   Work profit: for the works that happened in a period, what each earned and what it cost.
//         ?from= &to= (IST days; default this month, at most a year) &search= (client / booking no. / artist)
//         ?flag=loss|thin|no_costs|pending_costs &sort=date_desc|date_asc|profit_asc|profit_desc|margin_asc|margin_desc
//         ?page= &limit= (a page of works) or ?export=1 (every work; capped)
// @route  GET /api/work-profit
// @access Private — Accounts / finance head / admin
// @returns { from, to, items: [{ ...identity, revenue, costs, profit, marginPct, flags }], page, limit, totalItems, totalPages,
//            totals (every work in the period matching the search, whatever the flag), unallocated, gst, thinMarginPct, truncated }
export const getWorkProfit = async (req, res) => {
  try {
    if (!ACCOUNTS_ROLES.has(req.user?.role)) throw bad('Not authorized', 403);
    const [monthFrom, monthTo] = thisMonth();
    const from = req.query.from ? parseDayParam(req.query.from) : monthFrom;
    const to = req.query.to ? parseDayParam(req.query.to) : monthTo;
    if (!from || !to) throw bad('from / to must be days (YYYY-MM-DD)');
    if (from > to) throw bad('The "from" day is after the "to" day.');
    if (addDays(from, MAX_DAYS) < to) throw bad('Choose a period of a year or less.');
    const flag = String(req.query.flag ?? '');
    if (flag && !FLAGS.includes(flag)) throw bad('flag must be loss, thin, no_costs or pending_costs');
    const sort = req.query.sort ? String(req.query.sort) : 'date_desc';
    if (!SORTS.includes(sort)) throw bad(`sort must be one of ${SORTS.join(', ')}`);

    const { works, unallocated, gst } = await workProfitFor({ from, to });

    let rows = works.map(({ booking, row }) => ({ ...identityOf(booking), ...row }));
    const q = String(req.query.search ?? '').trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      rows = rows.filter((r) => rx.test(r.customerName) || rx.test(r.bookingNumber) || r.artists.some((a) => rx.test(a)));
    }
    const totals = summarize(rows, unallocated);

    let shown = flag ? rows.filter((r) => r.flags.includes(flag)) : rows;
    shown = sortRows(shown, sort);

    const base = { from, to, totals, unallocated, gst: { enabled: gst.enabled, rate: gst.rate, inclusive: gst.inclusive }, thinMarginPct: THIN_MARGIN_PCT };
    if (req.query.export === '1') {
      return res.json({ ...base, items: shown.slice(0, EXPORT_CAP), totalItems: shown.length, truncated: shown.length > EXPORT_CAP });
    }
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    res.json({
      ...base,
      items: shown.slice((page - 1) * limit, page * limit),
      page,
      limit,
      totalItems: shown.length,
      totalPages: Math.max(1, Math.ceil(shown.length / limit)),
      truncated: false,
    });
  } catch (err) {
    res.status(err.status ?? 500).json({ message: err.message });
  }
};
