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

// Resolve raw lines → {account, debit, credit}. A raw line names its ledger by
// `code`, or directly by `accountId` (the bank / cash ledger Accounts picked).
// Returns null if any referenced ledger is missing (COA not seeded, etc.).
const resolveLines = async (raw) => {
  const codes = [...new Set(raw.filter((l) => !l.accountId).map((l) => l.code))];
  const ids = [...new Set(raw.filter((l) => l.accountId).map((l) => String(l.accountId)))];
  const accounts = await ChartOfAccount.find({
    $or: [{ code: { $in: codes } }, { _id: { $in: ids } }],
  }).select('code').lean();
  const map = new Map(accounts.map((a) => [a.code, a._id]));
  const known = new Set(accounts.map((a) => String(a._id)));
  const lines = [];
  for (const l of raw) {
    const id = l.accountId ? (known.has(String(l.accountId)) ? l.accountId : null) : map.get(l.code);
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

// The cash / bank side of a voucher: the ledger Accounts chose in the approval
// popup when there is one, else the legacy guess from the payment mode.
const moneySide = (d, mode, amounts) =>
  d.ledgerAccount
    ? { accountId: d.ledgerAccount, ...amounts }
    : { code: cashOrBank(mode), ...amounts };

// Expense heads for records approved through the popup (records approved
// before it keep their original head, so re-syncing never rewrites history).
const FLEET_HEAD = {
  fuel: 'FUE-01', food: 'FOO-01', toll: 'TRP-01', parking: 'TRP-01',
  service: 'REP-01', outsource_salary: 'SAL-01', other: 'TRP-01',
};
const ARTIST_EXPENSE_HEAD = {
  food: 'FOO-01', travel: 'TRV-01', stay: 'TRV-01', fuel: 'FUE-01',
  materials: 'PRD-01', other: 'OFF-01',
};

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
        moneySide(d, d.paymentMode, { debit: amt, credit: 0 }),
        // A trial raises no receivable, so a trial-only payment verified through
        // the popup is revenue; everything else settles the booking's receivable.
        d.trialId && !d.bookingId && d.ledgerAccount
          ? { code: '4000', debit: 0, credit: amt } // Bridal Revenue
          : { code: '1200', debit: 0, credit: amt }, // Accounts Receivable
      ],
    };
  },

  // Administrative expense (with a controlled head + optional GST) → Payment.
  AdminExpense: (d) => {
    // Only approved expenses are money spent (the live hook already posts on
    // approval only; this keeps a ledger re-sync consistent with it).
    if (d.status !== 'approved') return null;
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
      lines.push(moneySide(d, d.paymentMethod, { debit: 0, credit: base + gst }));
    } else {
      lines.push(moneySide(d, d.paymentMethod, { debit: 0, credit: base }));
    }
    return { voucherType: 'payment', date: d.date, narration: `Expense · ${head}`, rawLines: lines };
  },

  // Vehicle fuel → Payment to the Fuel Expense head.
  // Posts once approved; pending / rejected bills stay out of the books.
  FuelExpense: (d) => {
    if (d.status !== 'approved') return null;
    const amt = round2(d.totalAmount);
    if (amt <= 0) return null;
    // Approved through the popup → head by category; older → Fuel as before.
    const head = d.ledgerAccount ? FLEET_HEAD[d.category] || 'TRP-01' : 'FUE-01';
    return {
      voucherType: 'payment',
      date: d.date,
      narration: d.ledgerAccount ? `Fleet · ${String(d.category || 'other').replace('_', ' ')}` : 'Fuel expense',
      rawLines: [
        { code: head, debit: amt, credit: 0 },
        d.ledgerAccount
          ? { accountId: d.ledgerAccount, debit: 0, credit: amt }
          : { code: d.paymentMode === 'cash' ? '1000' : '1010', debit: 0, credit: amt },
      ],
    };
  },

  // Artist field expense (food, travel…) reimbursed by Accounts. Only expenses
  // verified through the approval popup post — older verified ones were never
  // in the books and stay out.
  Expense: (d) => {
    if (d.status !== 'verified' || !d.ledgerAccount) return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.date,
      narration: `Artist expense · ${d.category || 'other'}`,
      rawLines: [
        { code: ARTIST_EXPENSE_HEAD[d.category] || 'OFF-01', debit: amt, credit: 0 },
        { accountId: d.ledgerAccount, debit: 0, credit: amt },
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
        moneySide(d, d.paymentMethod, { debit: 0, credit: amt }),
      ],
    };
  },

  // Paid freelance-artist fee → Payment to the Artist Payouts head (COGS).
  ArtistPayout: (d) => {
    if (d.status !== 'paid') return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.paidAt || d.date || d.updatedAt || d.createdAt,
      narration: `Artist payout · ${d.employeeName || ''}`.trim(),
      rawLines: [
        { code: 'APO-01', debit: amt, credit: 0 },
        moneySide(d, d.paymentMode, { debit: 0, credit: amt }),
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
        moneySide(d, d.paymentMethod, { debit: 0, credit: amt }),
      ],
    };
  },

  // Accounts' own Cash In / Cash Out / Transfer entries (CashTransaction).
  CashTransaction: (d) => {
    const amt = round2(d.amount);
    if (amt <= 0 || !d.ledgerAccount) return null;
    const label = [d.party, d.notes].filter(Boolean).join(' · ');
    if (d.type === 'transfer') {
      if (!d.toLedgerAccount) return null;
      return {
        voucherType: 'contra',
        date: d.date,
        narration: `Transfer${label ? ` · ${label}` : ''}`,
        rawLines: [
          { accountId: d.toLedgerAccount, debit: amt, credit: 0 },
          { accountId: d.ledgerAccount, debit: 0, credit: amt },
        ],
      };
    }
    if (!d.account) return null;
    if (d.type === 'in') {
      return {
        voucherType: 'receipt',
        date: d.date,
        narration: `Cash in${label ? ` · ${label}` : ''}`,
        rawLines: [
          { accountId: d.ledgerAccount, debit: amt, credit: 0 },
          { accountId: d.account, debit: 0, credit: amt },
        ],
      };
    }
    const gst = d.gstType === 'gst' ? round2(d.gstAmount) : 0;
    const lines = [{ accountId: d.account, debit: amt, credit: 0 }];
    if (gst > 0) lines.push({ code: '1300', debit: gst, credit: 0 }); // GST Input (ITC)
    lines.push({ accountId: d.ledgerAccount, debit: 0, credit: round2(amt + gst) });
    return {
      voucherType: 'payment',
      date: d.date,
      narration: `Cash out${label ? ` · ${label}` : ''}`,
      rawLines: lines,
    };
  },

  // Advance taken at booking, once Accounts verifies where it landed → Receipt
  // against the booking's receivable (source id = the booking).
  BookingAdvance: (d) => {
    if (d.advanceStatus !== 'verified' || !d.advanceLedgerAccount) return null;
    const amt = round2(d.advanceAmount);
    if (amt <= 0) return null;
    return {
      voucherType: 'receipt',
      date: d.createdAt || d.bookingDate,
      narration: `Advance · ${d.customerName || d.bookingNumber || 'Booking'}`,
      rawLines: [
        { accountId: d.advanceLedgerAccount, debit: amt, credit: 0 },
        { code: '1200', debit: 0, credit: amt }, // Accounts Receivable
      ],
    };
  },

  // Studio vendor bill → Purchase voucher: the goods / services as Product
  // Purchase (PRD-01) + input GST, owed to the vendor (Accounts Payable).
  // An artist's own purchase (owner set) is not the studio's spend.
  Purchase: (d) => {
    if (d.owner) return null;
    const base = round2(d.total);
    const gst = d.gstEnabled ? round2(d.gstAmount) : 0;
    if (base + gst <= 0) return null;
    const lines = [{ code: 'PRD-01', debit: base, credit: 0 }];
    if (gst > 0) lines.push({ code: '1300', debit: gst, credit: 0 }); // GST Input (ITC)
    lines.push({ code: '2000', debit: 0, credit: round2(base + gst) }); // Accounts Payable
    return {
      voucherType: 'purchase',
      date: d.date,
      narration: `Purchase · ${d.supplierName || d.supplier || 'Vendor'}${d.invoiceNo ? ` · ${d.invoiceNo}` : ''}`,
      rawLines: lines,
    };
  },

  // A payment against a vendor bill (one per Purchase.payments entry; the doc
  // is the payment merged with its bill's owner / supplier).
  PurchasePayment: (d) => {
    if (d.owner) return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'payment',
      date: d.date,
      narration: `Vendor payment · ${d.supplierName || 'Vendor'}`,
      rawLines: [
        { code: '2000', debit: amt, credit: 0 },
        moneySide(d, d.mode, { debit: 0, credit: amt }),
      ],
    };
  },

  // Refund to a bride → Credit note (Sales Return contra + refund paid).
  SalesReturn: (d) => {
    // Only a processed refund has left the bank / cash account.
    if (d.status !== 'processed') return null;
    const amt = round2(d.amount);
    if (amt <= 0) return null;
    return {
      voucherType: 'credit_note',
      date: d.date,
      narration: `Credit note · ${d.reason || ''}`.trim(),
      rawLines: [
        { code: 'SRT-01', debit: amt, credit: 0 },
        moneySide(d, d.paymentMode, { debit: 0, credit: amt }),
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

/// Remove the auto voucher for a source doc that was DELETED, so the ledger
/// doesn't keep an orphan entry (open period only). Call from delete handlers.
export const unpostDoc = async (model, id) => {
  await ensureLockDate();
  const res = await JournalEntry.deleteMany({
    'source.model': model,
    'source.id': id,
    ...lockFilter(),
  });
  return { status: 'ok', removed: res.deletedCount || 0 };
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
