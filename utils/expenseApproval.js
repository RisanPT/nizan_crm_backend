// What approving (or rejecting) an artist EXPENSE does to its amounts. Pure — tests/expenseApproval.test.js.
//
// The artist LOGS an amount; Accounts may APPROVE a smaller one (a bill they only part-accept, a
// meal over the limit, a rate they pay differently). Only the approved amount is spent: it is what
// the books post, what the Bank & Cash account is reduced by, and what every report adds up.
//
// So an Expense keeps ONE amount that counts:
//   amount        — what counts. Pending: what was logged. Approved: what was approved.
//   loggedAmount  — what the artist logged, kept ONLY when the approval changed it (else null).
//   approvalNote  — why it was reduced (optional, shown to the artist).
// Every existing reader of `amount` therefore keeps working and always agrees with the money moved.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const inr = (n) => `₹${round2(n).toLocaleString('en-IN')}`;
const NOTE_MAX = 300;

/// What the artist logged: the kept original when the approval changed it, else the amount itself.
export const loggedOf = (expense) => round2(expense.loggedAmount ?? expense.amount);

/// True when the amount that counts is less than what was logged.
export const isAdjusted = (expense) => expense.loggedAmount != null && round2(expense.loggedAmount) !== round2(expense.amount);

/**
 * Approving. `expense` is { amount, loggedAmount, approvalNote }; `input` is { approvedAmount, note }
 * as sent (anything may be missing — older clients send no amount).
 * @returns {{ error: string } | { amount, loggedAmount, approvalNote }}
 *   approvedAmount missing  → nothing changes (in full, or as it was already adjusted)
 *   approvedAmount = logged → in full: no original is kept
 *   approvedAmount < logged → adjusted: the original is kept, with the note
 *   approvedAmount > logged, ≤ 0 or not a number → error (the amount cannot grow here; fix the logged
 *                             amount first, or reject the expense)
 */
export const planApproval = (expense, input = {}) => {
  const logged = loggedOf(expense);
  const raw = input.approvedAmount;
  if (raw === undefined || raw === null || raw === '') {
    return { amount: round2(expense.amount), loggedAmount: expense.loggedAmount ?? null, approvalNote: expense.approvalNote ?? '' };
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { error: 'The approved amount is not a number.' };
  const approved = round2(n);
  if (approved <= 0) return { error: 'The approved amount must be more than ₹0. To pay nothing, reject the expense instead.' };
  if (approved > logged) {
    return { error: `The approved amount cannot be more than what was logged (${inr(logged)}). If the logged amount is wrong, edit the expense first.` };
  }
  if (approved === logged) return { amount: logged, loggedAmount: null, approvalNote: '' };
  return { amount: approved, loggedAmount: logged, approvalNote: String(input.note ?? '').trim().slice(0, NOTE_MAX) };
};

/// Rejecting: nothing is paid, so the expense goes back to the amount that was logged.
export const planRejection = (expense) => ({ amount: loggedOf(expense), loggedAmount: null, approvalNote: '' });
