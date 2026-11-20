import Collection from '../models/Collection.js';
import Expense from '../models/Expense.js';
import FuelExpense from '../models/FuelExpense.js';
import AdminExpense from '../models/AdminExpense.js';
import Salary from '../models/Salary.js';
import ArtistPayout from '../models/ArtistPayout.js';
import HraRecord from '../models/HraRecord.js';
import CashTransaction from '../models/CashTransaction.js';
import Booking from '../models/Booking.js';
import Purchase from '../models/Purchase.js';
import ExpenseClaim from '../models/ExpenseClaim.js';
import SalesReturn from '../models/SalesReturn.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import { computeAllocations } from './mealAllocation.js';
import { LINKED_LABELS } from '../utils/financeReportRows.js';
import { istDayKey } from '../utils/istDate.js';

// WHAT EACH BANK / CASH TRANSACTION WAS FOR.
//
// A row of an account's statement is a line of a journal voucher: a date, an amount in or out and a
// short narration ("Artist expense · food"). That says nothing about WHO spent it, on WHICH work, or
// what the bill said. The voucher remembers the record it was posted from (source.model + source.id),
// so this reads those records — in one query per kind, however many rows there are — and describes each
// row in the same shape whatever it is:
//
//   kind, kindLabel          'artist_expense' / 'Artist expense' — what sort of money movement
//   category, categoryLabel  'food' / 'Food' — its sub-kind (the expense head, the fleet category…)
//   group, groupLabel        kind + category: what the list is filtered by ("Artist expense · Food")
//   title, subtitle          the name to read first (client / payee) and who · which work · booking no.
//   person                   { id, name, role } — the artist, driver or employee behind it
//   client, bookingNumber, workDate, paymentMode, reference, notes, status, loggedAmount, attachmentUrl
//   details                  [{ label, value }] — everything known, in reading order, for the detail view
//
// A voucher keyed by hand (no source), or one whose record is gone, is described from the voucher itself.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `₹${round2(n).toLocaleString('en-IN')}`;
const cap = (s) => {
  const t = String(s ?? '').replace(/_/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
};
const day = (d) => {
  if (!d) return '';
  const k = istDayKey(d);
  return `${Number(k.slice(8, 10))} ${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
};
const dayTime = (d) => {
  if (!d) return '';
  const ist = new Date(new Date(d).getTime() + 330 * 60 * 1000);
  const h = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${day(d)}, ${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
};
const monthYear = (month, year) => {
  const m = Number(month);
  return m >= 1 && m <= 12 && year ? `${MONTHS[m - 1]} ${year}` : '';
};

const MODE_LABELS = {
  cash: 'Cash', petty_cash: 'Petty cash', upi: 'UPI', bank_transfer: 'Bank transfer', cheque: 'Cheque',
  card: 'Card', debit_card: 'Debit card', credit_card: 'Corporate card', other: 'Other',
};
export const modeLabel = (m) => MODE_LABELS[String(m ?? '')] ?? cap(m);

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : '');
const nameOf = (v) => (v && typeof v === 'object' ? String(v.name ?? '').trim() : '');
const person = (id, name, role) => (String(name ?? '').trim() ? { id: idOf(id), name: String(name).trim(), role } : null);

/// [[label, value], …] → [{ label, value }] without the empty ones.
const rows = (pairs) => pairs.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([label, v]) => ({ label, value: String(v) }));

const byId = (docs) => new Map(docs.map((d) => [String(d._id), d]));
const BOOKING_FIELDS = 'bookingNumber customerName service serviceStart serviceEnd';

// ── one describer per kind of record ────────────────────────────────────────

const KINDS = {
  Collection: {
    load: async (ids) =>
      byId(
        await Collection.find({ _id: { $in: ids } })
          .populate('employeeId', 'name')
          .populate('bookingId', BOOKING_FIELDS)
          .populate('trialId', 'trialNumber clientName trialDate')
          .populate('verifiedBy', 'name')
          .lean(),
      ),
    describe: (d) => {
      const b = d.bookingId && typeof d.bookingId === 'object' ? d.bookingId : null;
      const t = d.trialId && typeof d.trialId === 'object' ? d.trialId : null;
      const client = b?.customerName || t?.clientName || '';
      const number = b?.bookingNumber || t?.trialNumber || '';
      return {
        kind: 'collection',
        kindLabel: 'Collection',
        category: b ? 'booking' : t ? 'trial' : '',
        categoryLabel: b ? 'Booking' : t ? 'Trial' : '',
        title: client || 'Collection',
        person: person(d.employeeId, nameOf(d.employeeId), 'Collected by'),
        client,
        bookingNumber: number,
        workDate: b?.serviceStart ?? null,
        paymentMode: d.paymentMode,
        reference: d.paymentRef,
        notes: d.notes,
        status: d.status,
        attachmentUrl: d.attachmentUrl || '',
        details: rows([
          ['Client', client],
          [t && !b ? 'Trial no.' : 'Booking no.', number],
          ['Service', b?.service],
          ['Work date', day(b?.serviceStart)],
          ['Trial date', t && !b ? t.trialDate : ''],
          ['Collected by', nameOf(d.employeeId)],
          ['Collected on', day(d.date)],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.paymentRef],
          ['Verified by', nameOf(d.verifiedBy)],
          ['Verified on', day(d.verifiedAt)],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  Expense: {
    load: async (ids) => {
      const docs = await Expense.find({ _id: { $in: ids } })
        .populate('employeeId', 'name')
        .populate('bookingId', `${BOOKING_FIELDS} travelDistanceKm bookingItems.travelDistanceKm`)
        .populate('verifiedBy', 'name')
        .lean();
      // which work each one belongs to — the artist's pick, else placed by the time of the meal
      let allocation = { byExpense: new Map(), bookings: new Map() };
      try {
        allocation = await computeAllocations(docs);
      } catch (err) {
        console.error('bank transactions: could not place expenses under works:', err.message);
      }
      for (const d of docs) {
        const a = allocation.byExpense.get(String(d._id));
        const placed = (a?.shares ?? []).map((s) => allocation.bookings.get(s.bookingId)).find(Boolean);
        d._work = placed ?? (d.bookingId && typeof d.bookingId === 'object' ? d.bookingId : null);
        d._linked = placed ? (LINKED_LABELS[a.mode] ?? '') : d._work ? LINKED_LABELS.pinned : '';
      }
      return byId(docs);
    },
    describe: (d) => {
      const w = d._work;
      const meals = (d.meals?.length ? d.meals : d.meal ? [d.meal] : []).map(cap).join(' + ');
      const reduced = d.loggedAmount != null && round2(d.loggedAmount) !== round2(d.amount);
      const client = w?.customerName || (d.workType === 'model_shoot' ? 'Model shoot' : '');
      return {
        kind: 'artist_expense',
        kindLabel: 'Artist expense',
        category: d.category,
        categoryLabel: cap(d.category),
        title: client || 'Not tied to a work',
        person: person(d.employeeId, nameOf(d.employeeId), 'Artist'),
        client,
        bookingNumber: w?.bookingNumber || '',
        workDate: w?.serviceStart ?? null,
        paymentMode: d.paymentMode,
        reference: d.paymentRef,
        notes: d.notes,
        status: d.status,
        loggedAmount: reduced ? round2(d.loggedAmount) : null,
        attachmentUrl: d.receiptImage || '',
        details: rows([
          ['Artist', nameOf(d.employeeId)],
          ['Category', cap(d.category)],
          ['Meal', meals],
          ['Client / work', client || 'Not tied to a work'],
          ['Booking no.', w?.bookingNumber],
          ['Work date', day(w?.serviceStart)],
          ['Work linked', d._linked],
          ['Spent on', dayTime(d.date)],
          ['Logged amount', reduced ? rs(d.loggedAmount) : ''],
          ['Approved amount', rs(d.amount)],
          ['Why it was reduced', reduced ? d.approvalNote : ''],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.paymentRef],
          ['Approved by', nameOf(d.verifiedBy)],
          ['Approved on', day(d.verifiedAt)],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  FuelExpense: {
    load: async (ids) =>
      byId(
        await FuelExpense.find({ _id: { $in: ids } })
          .populate('vehicleId', 'name registrationNumber')
          .populate('driverId', 'name')
          .populate('bookingId', BOOKING_FIELDS)
          .lean(),
      ),
    describe: (d) => {
      const v = d.vehicleId && typeof d.vehicleId === 'object' ? d.vehicleId : null;
      const b = d.bookingId && typeof d.bookingId === 'object' ? d.bookingId : null;
      const vehicle = [v?.name, v?.registrationNumber].filter(Boolean).join(' · ');
      return {
        kind: 'fleet',
        kindLabel: 'Fleet',
        category: d.category || 'fuel',
        categoryLabel: cap(d.category || 'fuel'),
        title: vehicle || 'Vehicle',
        person: person(d.driverId, nameOf(d.driverId), 'Driver'),
        client: b?.customerName || '',
        bookingNumber: b?.bookingNumber || '',
        workDate: b?.serviceStart ?? null,
        paymentMode: d.paymentMode,
        reference: d.paymentRef,
        notes: d.notes,
        status: d.status,
        attachmentUrl: d.billImage || '',
        details: rows([
          ['Vehicle', vehicle],
          ['Driver', nameOf(d.driverId)],
          ['Category', cap(d.category || 'fuel')],
          ['Litres', d.liters ? String(d.liters) : ''],
          ['Odometer', d.odometerKm ? `${d.odometerKm} km` : ''],
          ['Station', d.station],
          ['Client / work', b?.customerName],
          ['Booking no.', b?.bookingNumber],
          ['Bill date', day(d.date)],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.paymentRef],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  AdminExpense: {
    load: async (ids) => byId(await AdminExpense.find({ _id: { $in: ids } }).populate('approvedBy', 'name').lean()),
    describe: (d, ctx) => {
      const head = ctx.heads.get(d.expenseHead) || '';
      const gst = d.gstType === 'gst' && d.gstAmount > 0 ? rs(d.gstAmount) : '';
      return {
        kind: 'admin_expense',
        kindLabel: 'Admin expense',
        category: d.expenseHead || d.category || '',
        categoryLabel: head || cap(d.category) || d.expenseHead || '',
        title: d.title || head || 'Expense',
        person: person(d.paidBy, d.paidByName, 'Paid by'),
        client: '',
        bookingNumber: '',
        workDate: null,
        paymentMode: d.paymentMethod,
        reference: d.paymentRef || d.invoiceNumber,
        notes: d.notes,
        status: d.status,
        attachmentUrl: d.receiptImage || '',
        details: rows([
          ['Expense', d.title],
          ['Expense head', [d.expenseHead, head].filter(Boolean).join(' · ')],
          ['Department', d.department],
          ['Category', cap(d.category)],
          ['Vendor', d.vendor],
          ['Invoice no.', d.invoiceNumber],
          ['Project', d.projectName],
          ['Amount', rs(d.amount)],
          ['GST', gst],
          ['Paid by', d.paidByName],
          ['Expense date', day(d.date)],
          ['Payment method', modeLabel(d.paymentMethod)],
          ['Reference', d.paymentRef],
          ['Approved by', nameOf(d.approvedBy)],
          ['Approved on', day(d.approvedAt)],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  Salary: {
    load: async (ids) => byId(await Salary.find({ _id: { $in: ids } }).lean()),
    describe: (d) => ({
      kind: 'salary',
      kindLabel: 'Salary',
      category: '',
      categoryLabel: '',
      title: d.employeeName || 'Salary',
      person: person(d.employeeId, d.employeeName, 'Employee'),
      client: '',
      bookingNumber: '',
      workDate: null,
      paymentMode: d.paymentMethod,
      reference: d.transactionRef || d.paymentRef,
      notes: d.notes,
      status: d.status,
      details: rows([
        ['Employee', d.employeeName],
        ['Department', d.department],
        ['Role', d.role],
        ['Salary for', monthYear(d.month, d.year)],
        ['Net paid', rs(d.netAmount)],
        ['Paid on', day(d.paymentDate || d.paidAt)],
        ['Payment method', modeLabel(d.paymentMethod)],
        ['Transaction ref', d.transactionRef || d.paymentRef],
        ['Notes', d.notes],
      ]),
    }),
  },

  ArtistPayout: {
    load: async (ids) => byId(await ArtistPayout.find({ _id: { $in: ids } }).populate('bookingId', BOOKING_FIELDS).populate('paidBy', 'name').lean()),
    describe: (d) => {
      const b = d.bookingId && typeof d.bookingId === 'object' ? d.bookingId : null;
      return {
        kind: 'artist_payout',
        kindLabel: 'Artist payout',
        category: '',
        categoryLabel: '',
        title: d.employeeName || 'Artist payout',
        person: person(d.employeeId, d.employeeName, 'Artist'),
        client: b?.customerName || '',
        bookingNumber: b?.bookingNumber || d.bookingNumber || '',
        workDate: b?.serviceStart ?? null,
        paymentMode: d.paymentMode,
        reference: d.paymentRef,
        notes: d.notes,
        status: d.status,
        details: rows([
          ['Artist', d.employeeName],
          ['Client / work', b?.customerName],
          ['Booking no.', b?.bookingNumber || d.bookingNumber],
          ['Work date', day(b?.serviceStart)],
          ['Paid on', day(d.paidAt || d.date)],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.paymentRef],
          ['Paid by', nameOf(d.paidBy)],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  HraRecord: {
    load: async (ids) => byId(await HraRecord.find({ _id: { $in: ids } }).lean()),
    describe: (d) => ({
      kind: 'hra',
      kindLabel: 'HRA',
      category: '',
      categoryLabel: '',
      title: d.employeeName || 'HRA',
      person: person(d.employeeId, d.employeeName, 'Employee'),
      client: '',
      bookingNumber: '',
      workDate: null,
      paymentMode: d.paymentMethod,
      reference: d.paymentRef,
      notes: d.notes,
      status: d.status,
      details: rows([
        ['Employee', d.employeeName],
        ['Department', d.department],
        ['HRA for', monthYear(d.month, d.year)],
        ['Paid on', day(d.date)],
        ['Payment method', modeLabel(d.paymentMethod)],
        ['Reference', d.paymentRef],
        ['Notes', d.notes],
      ]),
    }),
  },

  CashTransaction: {
    load: async (ids) => byId(await CashTransaction.find({ _id: { $in: ids } }).populate('account', 'code name').populate('toMoneyAccount', 'name').populate('moneyAccount', 'name').lean()),
    describe: (d) => {
      const head = d.account && typeof d.account === 'object' ? d.account : null;
      const transfer = d.type === 'transfer';
      const kind = transfer ? 'transfer' : d.type === 'in' ? 'cash_in' : 'cash_out';
      const kindLabel = transfer ? 'Transfer' : d.type === 'in' ? 'Cash in' : 'Cash out';
      const gst = d.gstType === 'gst' && d.gstAmount > 0 ? rs(d.gstAmount) : '';
      return {
        kind,
        kindLabel,
        category: transfer ? '' : head?.code || '',
        categoryLabel: transfer ? '' : head?.name || '',
        title: d.party || (transfer ? `${nameOf(d.moneyAccount) || 'Account'} → ${nameOf(d.toMoneyAccount) || 'account'}` : head?.name) || kindLabel,
        person: null,
        client: '',
        bookingNumber: '',
        workDate: null,
        paymentMode: d.paymentMode,
        reference: d.reference || d.paymentRef,
        notes: d.notes,
        status: '',
        attachmentUrl: d.attachmentUrl || '',
        details: rows([
          ['Entry', kindLabel],
          ['Head', head ? `${head.code} · ${head.name}` : ''],
          ['From account', transfer ? nameOf(d.moneyAccount) : ''],
          ['To account', transfer ? nameOf(d.toMoneyAccount) : ''],
          ['Party', d.party],
          ['Department', d.department],
          ['GST', gst],
          ['Date', day(d.date)],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.reference || d.paymentRef],
          ['Entered by', d.createdByName],
          ['Notes', d.notes],
        ]),
      };
    },
  },

  // the advance taken at booking — the voucher's source is the booking itself
  BookingAdvance: {
    load: async (ids) =>
      byId(
        await Booking.find({ _id: { $in: ids } })
          .select(`${BOOKING_FIELDS} advanceAmount advanceMode advancePaymentRef advanceVerifiedBy advanceVerifiedAt createdAt`)
          .populate('advanceVerifiedBy', 'name')
          .lean(),
      ),
    describe: (d) => ({
      kind: 'advance',
      kindLabel: 'Booking advance',
      category: '',
      categoryLabel: '',
      title: d.customerName || d.bookingNumber || 'Booking',
      person: null,
      client: d.customerName || '',
      bookingNumber: d.bookingNumber || '',
      workDate: d.serviceStart ?? null,
      paymentMode: d.advanceMode,
      reference: d.advancePaymentRef,
      notes: '',
      status: 'verified',
      details: rows([
        ['Client', d.customerName],
        ['Booking no.', d.bookingNumber],
        ['Service', d.service],
        ['Work date', day(d.serviceStart)],
        ['Advance', rs(d.advanceAmount)],
        ['Booked on', day(d.createdAt)],
        ['Payment mode', modeLabel(d.advanceMode)],
        ['Reference', d.advancePaymentRef],
        ['Verified by', nameOf(d.advanceVerifiedBy)],
        ['Verified on', day(d.advanceVerifiedAt)],
      ]),
    }),
  },

  // a payment against a vendor bill — the source is the payment inside the bill
  PurchasePayment: {
    load: async (ids) => {
      const bills = await Purchase.find({ 'payments._id': { $in: ids } }).populate('vendor', 'name').lean();
      const out = new Map();
      for (const bill of bills) for (const p of bill.payments ?? []) if (p._id) out.set(String(p._id), { ...p, _bill: bill });
      return out;
    },
    describe: (d) => {
      const bill = d._bill ?? {};
      const vendor = nameOf(bill.vendor) || bill.supplier || 'Vendor';
      const billTotal = round2((bill.total || 0) + (bill.gstEnabled ? bill.gstAmount || 0 : 0));
      return {
        kind: 'vendor_payment',
        kindLabel: 'Vendor payment',
        category: '',
        categoryLabel: '',
        title: vendor,
        person: null,
        client: '',
        bookingNumber: '',
        workDate: null,
        paymentMode: d.mode,
        reference: d.paymentRef,
        notes: d.note,
        status: 'paid',
        attachmentUrl: bill.billImage || '',
        details: rows([
          ['Vendor', vendor],
          ['Invoice no.', bill.invoiceNo],
          ['Bill date', day(bill.date)],
          ['Bill total', billTotal > 0 ? rs(billTotal) : ''],
          ['This payment', rs(d.amount)],
          ['Paid on', day(d.date)],
          ['Payment mode', modeLabel(d.mode)],
          ['Reference', d.paymentRef],
          ['Notes', d.note],
        ]),
      };
    },
  },

  ExpenseClaim: {
    load: async (ids) => byId(await ExpenseClaim.find({ _id: { $in: ids } }).lean()),
    describe: (d) => ({
      kind: 'reimbursement',
      kindLabel: 'Reimbursement',
      category: d.category || '',
      categoryLabel: cap(d.category),
      title: d.title || d.employeeName || 'Reimbursement',
      person: person(d.employeeId, d.employeeName, 'Employee'),
      client: '',
      bookingNumber: '',
      workDate: null,
      paymentMode: d.paymentMethod,
      reference: '',
      notes: d.description,
      status: d.status,
      attachmentUrl: d.receiptUrl || '',
      details: rows([
        ['Employee', d.employeeName],
        ['Department', d.department],
        ['Claim', d.title],
        ['Category', cap(d.category)],
        ['Spent on', day(d.date)],
        ['Paid on', day(d.paidAt)],
        ['Payment method', modeLabel(d.paymentMethod)],
        ['Description', d.description],
      ]),
    }),
  },

  SalesReturn: {
    load: async (ids) => byId(await SalesReturn.find({ _id: { $in: ids } }).populate('bookingId', BOOKING_FIELDS).populate('processedBy', 'name').lean()),
    describe: (d) => {
      const b = d.bookingId && typeof d.bookingId === 'object' ? d.bookingId : null;
      const client = d.brideName || b?.customerName || '';
      return {
        kind: 'refund',
        kindLabel: 'Refund',
        category: '',
        categoryLabel: '',
        title: client || 'Refund',
        person: null,
        client,
        bookingNumber: b?.bookingNumber || '',
        workDate: b?.serviceStart ?? null,
        paymentMode: d.paymentMode,
        reference: d.paymentRef || d.creditNoteNumber,
        notes: d.notes,
        status: d.status,
        attachmentUrl: d.attachmentUrl || '',
        details: rows([
          ['Client', client],
          ['Booking no.', b?.bookingNumber],
          ['Credit note no.', d.creditNoteNumber],
          ['Reason', d.reason],
          ['Refunded on', day(d.processedAt || d.date)],
          ['Payment mode', modeLabel(d.paymentMode)],
          ['Reference', d.paymentRef],
          ['Processed by', nameOf(d.processedBy)],
          ['Notes', d.notes],
        ]),
      };
    },
  },
};

const VOUCHER_LABELS = { receipt: 'Receipt', payment: 'Payment', contra: 'Transfer', journal: 'Journal', sales: 'Sales', purchase: 'Purchase', credit_note: 'Credit note', debit_note: 'Debit note' };

/// A voucher with no record behind it (keyed by hand, or its record was deleted): read from the voucher.
const fromVoucher = (row) => {
  const label = VOUCHER_LABELS[row.voucherType] ?? 'Journal';
  return {
    kind: row.voucherType === 'contra' ? 'transfer' : 'journal',
    kindLabel: label,
    category: '',
    categoryLabel: '',
    title: row.narration || label,
    person: null,
    client: '',
    bookingNumber: '',
    workDate: null,
    paymentMode: '',
    reference: '',
    notes: '',
    status: '',
    details: rows([['Narration', row.narration]]),
  };
};

/**
 * Describes each statement row. [rows] carry { source, sourceId, voucherNo, voucherType, narration,
 * against: [ledger account ids on the other side of the voucher] }. Returns new rows with the fields
 * listed at the top of this file added. Never throws for one bad record — that row falls back to the
 * voucher's own words.
 */
export const describeTransactions = async (list) => {
  // one query per kind of record
  const wanted = new Map();
  for (const r of list) {
    if (!r.source || !r.sourceId || !KINDS[r.source]) continue;
    if (!wanted.has(r.source)) wanted.set(r.source, new Set());
    wanted.get(r.source).add(String(r.sourceId));
  }
  const loaded = new Map();
  await Promise.all(
    [...wanted].map(async ([model, ids]) => {
      try {
        loaded.set(model, await KINDS[model].load([...ids]));
      } catch (err) {
        console.error(`bank transactions: could not read ${model} records:`, err.message);
        loaded.set(model, new Map());
      }
    }),
  );

  // the ledger heads on the other side of each voucher, and the names of the expense heads
  const heads = new Map();
  const accounts = new Map();
  try {
    const coa = await ChartOfAccount.find({}).select('code name').lean();
    for (const a of coa) {
      heads.set(a.code, a.name);
      accounts.set(String(a._id), a);
    }
  } catch (err) {
    console.error('bank transactions: could not read the chart of accounts:', err.message);
  }
  const ctx = { heads, accounts };
  const postedTo = (r) => (r.against ?? []).map((id) => accounts.get(String(id))).filter(Boolean).map((a) => `${a.code} · ${a.name}`).join(', ');

  return list.map((r) => {
    const doc = loaded.get(r.source)?.get(String(r.sourceId));
    let d;
    try {
      d = doc ? KINDS[r.source].describe(doc, ctx) : fromVoucher(r);
    } catch (err) {
      console.error(`bank transactions: could not describe a ${r.source} record:`, err.message);
      d = fromVoucher(r);
    }
    const group = d.category ? `${d.kind}:${d.category}` : d.kind;
    const groupLabel = d.categoryLabel ? `${d.kindLabel} · ${d.categoryLabel}` : d.kindLabel;
    const subtitle = [d.person?.name, d.client && d.client !== d.title ? d.client : '', d.bookingNumber].filter(Boolean).join(' · ');
    const { against, ...rest } = r;
    return {
      ...rest,
      ...d,
      attachmentUrl: d.attachmentUrl || '',
      loggedAmount: d.loggedAmount ?? null,
      group,
      groupLabel,
      particulars: groupLabel,
      subtitle,
      personKey: d.person ? d.person.id || `name:${d.person.name.toLowerCase()}` : '',
      details: [
        ...d.details,
        ...rows([
          ['Voucher', r.voucherNo],
          ['Posted to', postedTo(r)],
        ]),
      ],
    };
  });
};
