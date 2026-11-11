// Temporary logins for drivers (outsourced drivers, a vendor's driver for a season…).
//
// A login can carry an end date (User.accessExpiresAt): up to the end of that IST day it
// works as usual, after it sign-in and every request are refused. No end date = permanent,
// exactly as before. A driver who has no email signs in with their mobile number: the
// account is stored under a reserved address built from it. Pure — tests/driverLogin.test.js.

import { istEnd, isDay, todayIst, addDays, DAY_MS, istStart } from './istDate.js';

/// Reserved domain for accounts that sign in with a mobile number.
export const PHONE_LOGIN_DOMAIN = 'driver.nizan';
/// A temporary login can be given for at most this many days ahead.
export const MAX_TEMP_DAYS = 180;

/// The 10 digits of an Indian mobile number from whatever was typed ("+91 98950 00000"), or null.
export const phoneDigits = (value) => {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

/// The account address for a sign-in id: an email as typed (lower-cased), or the reserved
/// address for a mobile number. null when it is neither.
export const loginEmailFor = (id) => {
  const s = String(id ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) return s;
  const d = phoneDigits(s);
  return d ? `${d}@${PHONE_LOGIN_DOMAIN}` : null;
};

/// What the driver types to sign in: their mobile number for a phone account, else the email.
export const loginIdOf = (email) => {
  const s = String(email ?? '').toLowerCase();
  return s.endsWith(`@${PHONE_LOGIN_DOMAIN}`) ? s.split('@')[0] : s;
};

/**
 * "Valid until" day → the instant the login stops working (the end of that IST day).
 * @returns {{ at: Date|null } | { error: string }}  null day = no end date (permanent)
 */
export const expiryFromDay = (day, { today = todayIst() } = {}) => {
  if (day === null || day === undefined || day === '') return { at: null };
  const s = String(day).trim().slice(0, 10);
  if (!isDay(s) || Number.isNaN(istStart(s).getTime())) return { error: 'Pick a valid end date for the login.' };
  if (s < today) return { error: 'The end date has already passed.' };
  if ((istStart(s) - istStart(today)) / DAY_MS > MAX_TEMP_DAYS) {
    return { error: `A temporary login can run for at most ${MAX_TEMP_DAYS} days. Pick an earlier end date.` };
  }
  return { at: istEnd(s) };
};

/// True when the login has an end date that has passed.
export const loginExpired = (user, now = new Date()) =>
  !!user?.accessExpiresAt && new Date(user.accessExpiresAt).getTime() <= now.getTime();

/// The message a driver sees when it has.
export const EXPIRED_MESSAGE = 'This temporary login has ended. Ask the fleet manager to renew it.';

/**
 * May "grant a driver login" use this existing account? Only a driver account that is not
 * another driver's — never an admin's, an artist's or anyone else's, whose password it
 * would otherwise silently take over.
 * @returns {{ ok: true } | { error: string }}
 */
export const canReuseDriverAccount = (existing, employeeId) => {
  if (!existing) return { ok: true };
  if (existing.role !== 'driver') {
    return { error: `That login already belongs to a ${existing.role || 'staff'} account, not a driver. Use a different email or mobile number.` };
  }
  const mine = existing.employeeId ? String(existing.employeeId) : '';
  if (mine && employeeId && mine !== String(employeeId)) {
    return { error: 'That login already belongs to another driver. Use a different email or mobile number.' };
  }
  return { ok: true };
};

export { addDays };
