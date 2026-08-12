// ── Ledger posting engine (Phase 1) ─────────────────────────────────────────
// Turns operational source documents (collections, expenses, payroll, bookings,
// returns) into balanced double-entry journal vouchers. Idempotent per source:
// re-posting replaces the prior auto-generated entry. Hand-keyed vouchers (no
// `source`) are never touched. Never let a posting failure break the caller —
// use safePost() around live hooks.
import JournalEntry from '../models/JournalEntry.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import GstSetting from '../models/GstSetting.js';
import AccountingSetting from '../models/AccountingSetting.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const fyLabelFor = (date) => {
  const d = new Date(date || Date.now());
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const VOUCHER_PREFIX = {
  journal: 'JV', sales: 'SAL', purchase: 'PUR', receipt: 'RCP',
  payment: 'PAY', contra: 'CTR', credit_note: 'CRN', debit_note: 'DRN',
};

export const nextVoucherNo = async (voucherType, fyLabel) => {
  const count = await JournalEntry.countDocuments({ voucherType, fyLabel });
  return `${VOUCHER_PREFIX[voucherType] || 'JV'}/${fyLabel}/${String(count + 1).padStart(4, '0')}`;
};

// Resolve raw {code, debit, credit} lines → {account, debit, credit}.
// Returns null if any referenced ledger code is missing (COA not seeded, etc.).
const resolveLines = async (raw) => {
  const codes = [...new Set(raw.map((l) => l.code))];
  const accounts = await ChartOfAccount.find({ code: { $in: codes } }).select('code').lean();
  const map = new Map(accounts.map((a) => [a.code, a._id]));
  const lines = [];
  for (const l of raw) {
    const id = map.get(l.code);
    if (!id) return null;
    const debit = round2(l.debit);
    const credit = round2(l.credit);
    if (debit <= 0 && credit <= 0) continue;
    lines.push({ account: id, debit, credit, narration: l.narration || '' });
  }
  return lines;
};

// Cash vs bank ledger from a payment method string.
const cashOrBank = (method) =>
  ['cash', 'petty_cash'].includes(String(method || '')) ? '1000' : '1010';

// ── GST config (cached) ──────────────────────────────────────────────────────
// The booking builder is sync, so it reads this cached config; postDoc / the
// bulk backfill refresh it first via ensureGstConfig().
let _gst = { enabled: false, rate: 0, inclusive: true, interState: false };
let _gstLoadedAt = 0;

export const setGstConfig = (c = {}) => {
  _gst = {
    enabled: !!c.enabled,
    rate: Number(c.rate) || 0,
    inclusive: c.pricesIncludeTax !== false,
    interState: !!c.interState,
  };
  _gstLoadedAt = Date.now();
};

export const ensureGstConfig = async () => {
  if (_gstLoadedAt && Date.now() - _gstLoadedAt < 60000) return _gst;
  try {
    const doc = await GstSetting.findOne({}).lean();
    if (doc) setGstConfig(doc);
    else _gstLoadedAt = Date.now();
  } catch {
    _gstLoadedAt = Date.now();
  }
  return _gst;
};

// ── Period lock (cached) ─────────────────────────────────────────────────────
// null = books open. A date <= lockDate is in a closed period. Default null, so
// everything below is a no-op until the user deliberately closes a period.
let _lockDate = null;
let _lockLoadedAt = 0;

export const setLockDate = (d) => {
  _lockDate = d ? new Date(d) : null;
  _lockLoadedAt = Date.now();
};

export const ensureLockDate = async () => {
  if (_lockLoadedAt && Date.now() - _lockLoadedAt < 60000) return _lockDate;
  try {
    const doc = await AccountingSetting.findOne({}).lean();
    _lockDate = doc?.lockDate ? new Date(doc.lockDate) : null;
  } catch {
    // leave as-is
  }
  _lockLoadedAt = Date.now();
  return _lockDate;
};

/// True when [date] falls in a closed period. Always false while no lock is set.
export const isLocked = (date) => !!_lockDate && new Date(date) <= _lockDate;

// Mongo filter that restricts a query to the OPEN period (dates after the lock).
const lockFilter = () => (_lockDate ? { date: { $gt: _lockDate } } : {});

// ── Per-source builders ──────────────────────────────────────────────────────
// Each returns { voucherType, date, narration, rawLines } or null if the doc is
// not a postable event yet (wrong status, zero amount…).
const builders = {
  // Money received from a bride against a booking → Receipt.
  Collection: (d) => {
    if (d.status !== 'verified') return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'receipt',
      date: d.date,
      narration: `Collection${d.notes ? ` · ${d.notes}` : ''}`,
      rawLines: [
        { code: cashOrBank(d.paymentMode), debit: amt, credit: 0 },
        { code: '1200', debit: 0, credit: amt }, // Accounts Receivable
      ],
    };
  },

  // Administrative expense (with a controlled head + optional GST) → Payment.
  AdminExpense: (d) => {
    if (d.status === 'rejected') return null;
    // HRA mirrors (source:'hra') are posted via their HraRecord — skip the
    // mirror so HRA isn't counted twice.
    if (d.source === 'hra') return null;
    const base = round2(d.amount);
    if (base <= 0) return null;
    const head = d.expenseHead || 'OFF-01';
    const gst = round2(d.gstAmount);
    const lines = [{ code: head, debit: base, credit: 0 }];
    if (d.gstType === 'gst' && gst > 0) {
      lines.push({ code: '1300', debit: gst, credit: 0 }); // GST Input (ITC)
      lines.push({ code: cashOrBank(d.paymentMethod), debit: 0, credit: base + gst });
    } else {
      lines.push({ code: cashOrBank(d.paymentMethod), debit: 0, credit: base });
    }
    return { voucherType: 'payment', date: d.date, narration: `Expense · ${head}`, rawLines: lines };
  },

  // Vehicle fuel → Payment to the Fuel Expense head.
  FuelExpense: (d) => {
    if (d.status === 'rejected') return null;
    const amt = round2(d.totalAmount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.date,
      narration: 'Fuel expense',
      rawLines: [
        { code: 'FUE-01', debit: amt, credit: 0 },
        { code: d.paymentMode === 'cash' ? '1000' : '1010', debit: 0, credit: amt },
      ],
    };
  },

  // Paid salary → Payment to Salary & Allowance.
  Salary: (d) => {
    if (d.status !== 'paid') return null;
    const amt = round2(d.netAmount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.paymentDate || d.updatedAt || d.createdAt,
      narration: `Salary · ${d.employeeName || ''}`.trim(),
      rawLines: [
        { code: 'SAL-01', debit: amt, credit: 0 },
        { code: cashOrBank(d.paymentMethod), debit: 0, credit: amt },
      ],
    };
  },

  // Paid HRA → Payment to House Rent Allowance.
  HraRecord: (d) => {
    if (d.status !== 'paid') return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.date,
      narration: `HRA · ${d.employeeName || ''}`.trim(),
      rawLines: [
        { code: '5010', debit: amt, credit: 0 },
        { code: cashOrBank(d.paymentMethod), debit: 0, credit: amt },
      ],
    };
  },

  // Refund to a bride → Credit note (Sales Return contra + refund paid).
  SalesReturn: (d) => {
    if (!['approved', 'processed'].includes(d.status)) return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'credit_note',
      date: d.date,
      narration: `Credit note · ${d.reason || ''}`.trim(),
      rawLines: [
        { code: 'SRT-01', debit: amt, credit: 0 },
        { code: d.paymentMode === 'cash' ? '1000' : '1010', debit: 0, credit: amt },
      ],
    };
  },

  // Confirmed booking → Sales invoice (raises a receivable against revenue),
  // splitting output GST per the configured rate / inclusive / place-of-supply.
  Booking: (d) => {
    const st = String(d.status || '').toLowerCase();
    if (['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'].includes(st)) return null;
    const price = round2(d.totalPrice);
    if (price <= 0) return null;

    const date = d.bookingDate || d.createdAt;
    const narration = `Sales · ${d.customerName || 'Booking'}`;

    // No GST configured → post revenue gross.
    if (!_gst.enabled || _gst.rate <= 0) {
      return {
        voucherType: 'sales', date, narration,
        rawLines: [
          { code: '1200', debit: price, credit: 0 },
          { code: '4000', debit: 0, credit: price },
        ],
      };
    }

    // Inclusive: back the tax out of the price. Exclusive: add it on top.
    const taxable = _gst.inclusive ? round2(price / (1 + _gst.rate / 100)) : price;
    const gst = round2(_gst.inclusive ? price - taxable : price * (_gst.rate / 100));
    const arGross = round2(taxable + gst); // = price (inclusive) or price+gst (exclusive)

    const lines = [
      { code: '1200', debit: arGross, credit: 0 }, // Accounts Receivable
      { code: '4000', debit: 0, credit: taxable }, // Revenue (taxable value)
    ];
    if (_gst.interState) {
      lines.push({ code: '2120', debit: 0, credit: gst }); // Output IGST
    } else {
      const cgst = round2(gst / 2);
      lines.push({ code: '2100', debit: 0, credit: cgst }); // Output CGST
      lines.push({ code: '2110', debit: 0, credit: round2(gst - cgst) }); // Output SGST
    }
    return { voucherType: 'sales', date, narration, rawLines: lines };
  },
};

export const POSTABLE_MODELS = Object.keys(builders);

/// Build the voucher spec ({ voucherType, date, narration, rawLines }) for a
/// source doc without touching the DB — used by the bulk backfill.
export const buildSpecFor = (model, doc) => {
  const build = builders[model];
  return build ? build(doc) : null;
};

// Core: (re)post the journal voucher for one source document. Deletes any prior
// auto-generated entry for this source, then creates the fresh balanced entry.
const postSpec = async ({ model, id, voucherType, date, narration, rawLines, createdBy }) => {
  const lines = await resolveLines(rawLines);
  if (!lines || lines.length < 2) return { status: 'skipped', reason: 'accounts-missing' };
  const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
  const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
  if (dr !== cr || dr <= 0) return { status: 'skipped', reason: 'unbalanced' };

  // Auto entries are regenerable — replace the prior one for this source, but
  // never disturb entries that fall in a closed (locked) period.
  await JournalEntry.deleteMany({ 'source.model': model, 'source.id': id, ...lockFilter() });
  const fyLabel = fyLabelFor(date);
  const voucherNo = await nextVoucherNo(voucherType, fyLabel);
  const entry = await JournalEntry.create({
    date: date || new Date(),
    voucherType,
    voucherNo,
    narration,
    lines,
    source: { model, id },
    status: 'posted',
    postedAt: new Date(),
    fyLabel,
    createdBy: createdBy || null,
  });
  return { status: 'posted', entry };
};

/// Post a single source document by model name (e.g. 'Collection', 'Booking').
export const postDoc = async (model, doc, createdBy = null) => {
  const build = builders[model];
  if (!build) return { status: 'skipped', reason: 'no-builder' };
  if (model === 'Booking') await ensureGstConfig(); // sales split needs fresh GST config
  await ensureLockDate();
  const spec = build(doc);
  if (!spec) {
    // Not (or no longer) a postable event — clear any stale auto entry (open period only).
    await JournalEntry.deleteMany({ 'source.model': model, 'source.id': doc._id, ...lockFilter() });
    return { status: 'skipped', reason: 'not-eligible' };
  }
  if (isLocked(spec.date)) return { status: 'skipped', reason: 'period-locked' };
  return postSpec({ model, id: doc._id, createdBy, ...spec });
};

/// Best-effort wrapper for live controller hooks — never throws.
export const safePost = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error('posting failed:', err.message);
    return { status: 'error', reason: err.message };
  }
};
