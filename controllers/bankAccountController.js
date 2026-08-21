import BankAccount from '../models/BankAccount.js';

// Finance staff manage bank balances.
const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManage = (u) => FINANCE_ROLES.includes(String(u?.role || '').toLowerCase());

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// @route GET /api/bank-accounts  — list accounts + total balance
export const getBankAccounts = async (req, res) => {
  try {
    const includeInactive = req.query.all === 'true';
    const filter = includeInactive ? {} : { active: true };
    const accounts = await BankAccount.find(filter).sort({ name: 1 }).lean();
    const totalBalance = accounts
      .filter((a) => a.active)
      .reduce((s, a) => s + (a.balance || 0), 0);
    res.json({ accounts, totalBalance });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/bank-accounts  — add an account (with an opening balance)
export const createBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'An account name is required' });

    const balance = num(req.body.balance);
    const asOf = req.body.asOf ? new Date(req.body.asOf) : new Date();
    const doc = await BankAccount.create({
      name,
      bankName: String(req.body.bankName || '').trim(),
      accountNumber: String(req.body.accountNumber || '').trim(),
      balance,
      asOf,
      note: String(req.body.note || ''),
      history: [{
        balance,
        asOf,
        note: 'Opening balance',
        byId: req.user?._id ?? null,
        byName: req.user?.name ?? '',
      }],
    });
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/bank-accounts/:id  — edit the account's details (not balance)
export const updateBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    const b = req.body;
    if (b.name !== undefined) doc.name = String(b.name).trim() || doc.name;
    if (b.bankName !== undefined) doc.bankName = String(b.bankName).trim();
    if (b.accountNumber !== undefined) doc.accountNumber = String(b.accountNumber).trim();
    if (b.note !== undefined) doc.note = String(b.note);
    if (b.active !== undefined) doc.active = !!b.active;
    await doc.save();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/bank-accounts/:id/balance  — record a new manual balance
export const recordBalance = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    if (req.body.balance === undefined || req.body.balance === null || req.body.balance === '') {
      return res.status(400).json({ message: 'A balance amount is required' });
    }
    const balance = num(req.body.balance);
    const asOf = req.body.asOf ? new Date(req.body.asOf) : new Date();
    doc.balance = balance;
    doc.asOf = asOf;
    doc.history.push({
      balance,
      asOf,
      note: String(req.body.note || ''),
      byId: req.user?._id ?? null,
      byName: req.user?.name ?? '',
    });
    await doc.save();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/bank-accounts/:id
export const deleteBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    res.json({ message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
