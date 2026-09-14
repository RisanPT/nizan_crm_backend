import TaxFiling, { FILING_LABELS } from '../models/TaxFiling.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import { accountMovements, round2 } from './accountingController.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManage = (u) => FINANCE_ROLES.includes(u?.role);

const d = (y, m, day) => new Date(y, m - 1, day); // m is 1-based
const nextMonth = (m, y) => (m === 12 ? { m: 1, y: y + 1 } : { m: m + 1, y });

// The statutory returns DUE for transactions of period (month, year), with the
// standard Indian due dates. GSTR-1 11th, GSTR-3B 20th, TDS payment 7th (all of
// the following month); TDS return quarterly (quarter-end month only).
const expectedFilings = (month, year) => {
  const nx = nextMonth(month, year);
  const out = [
    { type: 'gstr1', periodMonth: month, periodYear: year, dueDate: d(nx.y, nx.m, 11) },
    { type: 'gstr3b', periodMonth: month, periodYear: year, dueDate: d(nx.y, nx.m, 20) },
    { type: 'tds_payment', periodMonth: month, periodYear: year, dueDate: d(nx.y, nx.m, 7) },
  ];
  // Quarterly TDS return, keyed to the quarter-end month.
  const tdsReturnDue = { 6: d(year, 7, 31), 9: d(year, 10, 31), 12: d(year + 1, 1, 31), 3: d(year, 5, 31) };
  if (tdsReturnDue[month]) {
    out.push({ type: 'tds_return', periodMonth: month, periodYear: year, dueDate: tdsReturnDue[month] });
  }
  return out.map((f) => ({ ...f, label: FILING_LABELS[f.type] }));
};

const deriveStatus = (expected, saved, now) => {
  if (saved && saved.status === 'filed') return 'filed';
  if (expected.dueDate && expected.dueDate < now) return 'overdue';
  return 'pending';
};

const mergeOne = (expected, saved, now) => ({
  type: expected.type,
  label: expected.label,
  periodMonth: expected.periodMonth,
  periodYear: expected.periodYear,
  dueDate: expected.dueDate,
  status: deriveStatus(expected, saved, now),
  filedDate: saved?.filedDate ?? null,
  arn: saved?.arn ?? '',
  amount: saved?.amount ?? null,
  notes: saved?.notes ?? '',
  id: saved?._id ?? null,
});

// Merged (expected + saved) filings for a single period — reused by Month-End.
export const filingsForPeriod = async (month, year) => {
  const now = new Date();
  const expected = expectedFilings(month, year);
  const saved = await TaxFiling.find({ periodMonth: month, periodYear: year }).lean();
  const savedByType = new Map(saved.map((s) => [s.type, s]));
  return expected.map((e) => mergeOne(e, savedByType.get(e.type), now));
};

// Suggested payable amount from the ledger for the period, for GSTR-3B (GST net)
// and TDS payment (TDS Payable account credit).
const suggestedAmounts = async (month, year) => {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0, 23, 59, 59, 999);
  const [accounts, mv] = await Promise.all([
    ChartOfAccount.find({ code: { $in: ['2100', '2110', '2120', '1300', '2200'] } }).select('code').lean(),
    accountMovements({ from, to }),
  ]);
  const byCode = new Map(accounts.map((a) => [a.code, String(a._id)]));
  const cr = (code) => {
    const id = byCode.get(code);
    const m = id ? mv.get(id) : null;
    return m ? m.credit - m.debit : 0;
  };
  const dr = (code) => {
    const id = byCode.get(code);
    const m = id ? mv.get(id) : null;
    return m ? m.debit - m.credit : 0;
  };
  const gstNet = round2(cr('2100') + cr('2110') + cr('2120') - dr('1300'));
  const tds = round2(cr('2200'));
  return { gstr3b: Math.max(0, gstNet), tds_payment: Math.max(0, tds) };
};

// @route GET /api/tax-filings?month=&year=
// Returns the selected period's statutory filings (with suggested amounts) plus
// any past-due unfiled filings from the previous 12 periods (overdue watchlist).
export const getTaxFilings = async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ message: 'No finance access' });
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();

    // Selected period (with suggested amounts).
    const [periodFilings, amounts] = await Promise.all([
      filingsForPeriod(month, year),
      suggestedAmounts(month, year),
    ]);
    for (const f of periodFilings) {
      if (f.status !== 'filed' && amounts[f.type] != null) f.amount = amounts[f.type];
    }

    // Overdue watchlist across the previous 12 periods (status only).
    const periods = [];
    let m = month;
    let y = year;
    for (let i = 0; i < 12; i++) {
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      periods.push({ m, y });
    }
    const rangeStart = new Date(y, m - 1, 1);
    const saved = await TaxFiling.find({
      $or: periods.map((p) => ({ periodMonth: p.m, periodYear: p.y })),
    }).lean();
    const savedKey = new Map(saved.map((s) => [`${s.type}-${s.periodMonth}-${s.periodYear}`, s]));
    const overdue = [];
    for (const p of periods) {
      for (const e of expectedFilings(p.m, p.y)) {
        const s = savedKey.get(`${e.type}-${e.periodMonth}-${e.periodYear}`);
        const merged = mergeOne(e, s, now);
        if (merged.status === 'overdue') overdue.push(merged);
      }
    }
    overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    const summary = {
      overdue: overdue.length,
      pending: periodFilings.filter((f) => f.status === 'pending').length,
      filed: periodFilings.filter((f) => f.status === 'filed').length,
    };
    res.json({ period: { month, year, rangeStart }, filings: periodFilings, overdue, summary });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/tax-filings  (upsert by type + period)
export const upsertTaxFiling = async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ message: 'No finance access' });
    const { type, periodMonth, periodYear } = req.body;
    const m = Number(periodMonth);
    const y = Number(periodYear);
    if (!FILING_LABELS[type] || !m || m < 1 || m > 12 || !y) {
      return res.status(400).json({ message: 'A valid filing type, month and year are required.' });
    }
    // Store the statutory due date alongside the record.
    const expected = expectedFilings(m, y).find((e) => e.type === type);
    const status = req.body.status === 'pending' ? 'pending' : 'filed';
    const doc = await TaxFiling.findOneAndUpdate(
      { type, periodMonth: m, periodYear: y },
      {
        $set: {
          status,
          dueDate: expected?.dueDate ?? null,
          filedDate: status === 'filed' ? (req.body.filedDate ? new Date(req.body.filedDate) : new Date()) : null,
          arn: req.body.arn ?? '',
          amount: Number(req.body.amount) || 0,
          notes: req.body.notes ?? '',
          filedBy: req.user?._id ?? null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json(doc);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'This filing is already recorded.' });
    }
    res.status(500).json({ message: error.message });
  }
};
