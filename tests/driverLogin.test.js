// Pure unit tests: node --test tests/driverLogin.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  phoneDigits, loginEmailFor, loginIdOf, expiryFromDay, loginExpired, canReuseDriverAccount, MAX_TEMP_DAYS, PHONE_LOGIN_DOMAIN,
} from '../utils/driverLogin.js';

test('a mobile number is reduced to its 10 digits', () => {
  assert.equal(phoneDigits('98950 00000'), '9895000000');
  assert.equal(phoneDigits('+91 98950-00000'), '9895000000');
  assert.equal(phoneDigits('0091 9895000000'), '9895000000');
  assert.equal(phoneDigits('12345'), null);
  assert.equal(phoneDigits(''), null);
});

test('the sign-in id becomes an account address: an email as typed, a number as the reserved address', () => {
  assert.equal(loginEmailFor(' Suresh@Vendor.TEST '), 'suresh@vendor.test');
  assert.equal(loginEmailFor('9895000000'), `9895000000@${PHONE_LOGIN_DOMAIN}`);
  assert.equal(loginEmailFor('+91 98950 00000'), `9895000000@${PHONE_LOGIN_DOMAIN}`);
  assert.equal(loginEmailFor('nonsense'), null);
  assert.equal(loginEmailFor(''), null);
});

test('what the driver types is their number, not the reserved address', () => {
  assert.equal(loginIdOf(`9895000000@${PHONE_LOGIN_DOMAIN}`), '9895000000');
  assert.equal(loginIdOf('suresh@vendor.test'), 'suresh@vendor.test');
});

test('no end date = a permanent login', () => {
  assert.deepEqual(expiryFromDay(null), { at: null });
  assert.deepEqual(expiryFromDay(''), { at: null });
  assert.deepEqual(expiryFromDay(undefined), { at: null });
});

test('an end date runs to the END of that day in Indian time', () => {
  const { at } = expiryFromDay('2026-11-09', { today: '2026-11-02' });
  assert.equal(at.toISOString(), '2026-11-09T18:29:59.999Z'); // 23:59:59.999 IST
  assert.ok(!loginExpired({ accessExpiresAt: at }, new Date('2026-11-09T18:00:00Z'))); // 23:30 IST: still valid
  assert.ok(loginExpired({ accessExpiresAt: at }, new Date('2026-11-09T18:30:00Z'))); // 00:00 IST next day: over
});

test('today is allowed as an end date; yesterday, a typo and a far-off date are not', () => {
  assert.ok(expiryFromDay('2026-11-02', { today: '2026-11-02' }).at);
  assert.match(expiryFromDay('2026-11-01', { today: '2026-11-02' }).error, /already passed/);
  assert.match(expiryFromDay('2026-13-45', { today: '2026-11-02' }).error, /valid end date/);
  assert.match(expiryFromDay('soon', { today: '2026-11-02' }).error, /valid end date/);
  assert.ok(expiryFromDay('2027-04-30', { today: '2026-11-02' }).at); // 179 days
  assert.match(expiryFromDay('2027-06-01', { today: '2026-11-02' }).error, new RegExp(`${MAX_TEMP_DAYS} days`));
});

test('an ISO timestamp from the app is read as its day', () => {
  assert.ok(expiryFromDay('2026-11-09T00:00:00.000', { today: '2026-11-02' }).at);
});

test('only a login with an end date that has passed is expired', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  assert.equal(loginExpired({ accessExpiresAt: null }, now), false);
  assert.equal(loginExpired({}, now), false);
  assert.equal(loginExpired(null, now), false);
  assert.equal(loginExpired({ accessExpiresAt: new Date('2026-11-09T00:00:00Z') }, now), true);
  assert.equal(loginExpired({ accessExpiresAt: new Date('2026-11-11T00:00:00Z') }, now), false);
});

test('granting a driver login never takes over somebody else\'s account', () => {
  assert.deepEqual(canReuseDriverAccount(null, 'e1'), { ok: true });
  assert.match(canReuseDriverAccount({ role: 'admin' }, 'e1').error, /admin account/);
  assert.match(canReuseDriverAccount({ role: 'artist' }, 'e1').error, /artist account/);
  assert.match(canReuseDriverAccount({ role: '' }, 'e1').error, /staff account/);
});

test('a driver account is reusable by the same driver, or when it belongs to no one yet, but not by another driver', () => {
  assert.deepEqual(canReuseDriverAccount({ role: 'driver', employeeId: 'e1' }, 'e1'), { ok: true });
  assert.deepEqual(canReuseDriverAccount({ role: 'driver', employeeId: null }, 'e1'), { ok: true });
  assert.deepEqual(canReuseDriverAccount({ role: 'driver', employeeId: 'e1' }, null), { ok: true });
  assert.match(canReuseDriverAccount({ role: 'driver', employeeId: 'e1' }, 'e2').error, /another driver/);
});
