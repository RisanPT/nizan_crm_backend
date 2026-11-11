import test from 'node:test';
import assert from 'node:assert/strict';
import { FUEL_TYPES, MIN_QUANTITY, TOLERANCE_PCT, UNITS, currentPrices, priceOn, priceTypeOf, rateCheck, suggestAmount, validatePrice } from '../utils/fuelPrice.js';

const row = (fuelType, pricePerUnit, effectiveFrom) => ({ fuelType, pricePerUnit, effectiveFrom });

test('the fuels that have a price, and what each is counted in', () => {
  assert.deepEqual(FUEL_TYPES, ['petrol', 'diesel', 'cng', 'electric']);
  assert.deepEqual(UNITS, { petrol: 'litre', diesel: 'litre', cng: 'kg', electric: 'kWh' });
});

test('a vehicle\'s fuel type finds its price: a hybrid runs on petrol, "other" has none', () => {
  for (const t of ['petrol', 'diesel', 'cng', 'electric']) assert.equal(priceTypeOf(t), t);
  assert.equal(priceTypeOf('hybrid'), 'petrol');
  assert.equal(priceTypeOf('PETROL'), 'petrol');
  for (const none of ['other', '', null, undefined, 'hydrogen']) assert.equal(priceTypeOf(none), null, String(none));
});

// ── adding a price ──
test('a good price is cleaned', () => {
  const r = validatePrice({ fuelType: 'Petrol', pricePerUnit: '105.456', effectiveFrom: ' 2026-10-01 ', note: '  Kozhikode ' });
  assert.deepEqual(r, { clean: { fuelType: 'petrol', pricePerUnit: 105.46, effectiveFrom: '2026-10-01', note: 'Kozhikode' } });
});

test('a fuel we do not price is refused', () => {
  for (const bad of ['', 'kerosene', undefined, 'hybrid']) {
    assert.match(validatePrice({ fuelType: bad, pricePerUnit: 100, effectiveFrom: '2026-10-01' }).error, /Choose a fuel/, String(bad));
  }
});

test('the price must be a number above 0 and not absurd', () => {
  for (const bad of ['', null, undefined, 0, -5, 'abc', NaN]) {
    assert.match(validatePrice({ fuelType: 'diesel', pricePerUnit: bad, effectiveFrom: '2026-10-01' }).error, /Enter the price per litre/, String(bad));
  }
  assert.match(validatePrice({ fuelType: 'cng', pricePerUnit: 0, effectiveFrom: '2026-10-01' }).error, /per kg/);
  assert.match(validatePrice({ fuelType: 'electric', pricePerUnit: '', effectiveFrom: '2026-10-01' }).error, /per kWh/);
  assert.match(validatePrice({ fuelType: 'petrol', pricePerUnit: 1000.01, effectiveFrom: '2026-10-01' }).error, /more than ₹1000/);
  assert.ok(validatePrice({ fuelType: 'petrol', pricePerUnit: 1000, effectiveFrom: '2026-10-01' }).clean);
});

test('the start day must be a real calendar day', () => {
  for (const bad of ['', undefined, '01-10-2026', '2026-13-01', '2026-02-30', '2026-10-1', 'today']) {
    assert.match(validatePrice({ fuelType: 'petrol', pricePerUnit: 100, effectiveFrom: bad }).error, /"from" date/, String(bad));
  }
  assert.ok(validatePrice({ fuelType: 'petrol', pricePerUnit: 100, effectiveFrom: '2028-02-29' }).clean, 'a leap day is real');
});

test('a long note is refused', () => {
  assert.match(validatePrice({ fuelType: 'petrol', pricePerUnit: 100, effectiveFrom: '2026-10-01', note: 'x'.repeat(201) }).error, /note is too long/);
  assert.ok(validatePrice({ fuelType: 'petrol', pricePerUnit: 100, effectiveFrom: '2026-10-01', note: 'x'.repeat(200) }).clean);
});

test('two prices for the same fuel on the same day clash; a different fuel or day does not', () => {
  const existing = [row('petrol', 105, '2026-10-01')];
  const clash = validatePrice({ fuelType: 'petrol', pricePerUnit: 106, effectiveFrom: '2026-10-01' }, existing);
  assert.equal(clash.conflict, true);
  assert.match(clash.error, /already a petrol price from that date \(₹105\)/);
  assert.ok(validatePrice({ fuelType: 'diesel', pricePerUnit: 96, effectiveFrom: '2026-10-01' }, existing).clean);
  assert.ok(validatePrice({ fuelType: 'petrol', pricePerUnit: 106, effectiveFrom: '2026-10-02' }, existing).clean);
});

// ── which price applies on a day ──
test('the price in force on a day is the latest one that has started', () => {
  const rows = [row('petrol', 100, '2026-01-01'), row('petrol', 105, '2026-06-15'), row('petrol', 110, '2026-10-01'), row('diesel', 95, '2026-01-01')];
  assert.equal(priceOn(rows, 'petrol', '2026-03-10').pricePerUnit, 100);
  assert.equal(priceOn(rows, 'petrol', '2026-06-15').pricePerUnit, 105, 'the start day itself counts');
  assert.equal(priceOn(rows, 'petrol', '2026-06-14').pricePerUnit, 100);
  assert.equal(priceOn(rows, 'petrol', '2026-10-23').pricePerUnit, 110);
  assert.equal(priceOn(rows, 'diesel', '2026-10-23').pricePerUnit, 95);
});

test('before the first price, or for a fuel with none, there is no price (nothing is guessed)', () => {
  const rows = [row('petrol', 100, '2026-01-01')];
  assert.equal(priceOn(rows, 'petrol', '2025-12-31'), null);
  assert.equal(priceOn(rows, 'diesel', '2026-10-23'), null);
  assert.equal(priceOn([], 'petrol', '2026-10-23'), null);
  assert.equal(priceOn(undefined, 'petrol', '2026-10-23'), null);
});

test('a price set for a future day does not apply yet', () => {
  const rows = [row('petrol', 100, '2026-01-01'), row('petrol', 120, '2026-11-01')];
  assert.equal(priceOn(rows, 'petrol', '2026-10-23').pricePerUnit, 100);
});

test('today\'s prices: each fuel, null where none is set', () => {
  const cur = currentPrices([row('petrol', 100, '2026-01-01'), row('diesel', 95, '2026-01-01'), row('diesel', 97, '2026-10-20')], '2026-10-23');
  assert.deepEqual([cur.petrol.pricePerUnit, cur.diesel.pricePerUnit, cur.cng, cur.electric], [100, 97, null, null]);
});

// ── fill-in ──
test('litres × price is the amount to fill in, to the paisa', () => {
  assert.equal(suggestAmount(40, 105.45), 4218);
  assert.equal(suggestAmount(40.35, 105.45), 4254.91);
  assert.equal(suggestAmount('10', '96.5'), 965);
});

test('nothing to fill in without a quantity and a price', () => {
  for (const [q, p] of [[0, 100], [-1, 100], [10, 0], [10, null], [null, 100], ['', 100], ['x', 100], [10, undefined]]) {
    assert.equal(suggestAmount(q, p), null, `${q} × ${p}`);
  }
});

// ── the bill check ──
test('a rate close to the price is fine', () => {
  const r = rateCheck({ quantity: 40, amount: 4218, price: 105.45 });
  assert.deepEqual(r, { status: 'ok', rate: 105.45, price: 105.45, expected: 4218, diff: 0, diffPct: 0, tolerancePct: 10 });
});

test('a few percent either way is fine (pumps differ town to town)', () => {
  assert.equal(rateCheck({ quantity: 40, amount: 4218 * 1.05, price: 105.45 }).status, 'ok');
  assert.equal(rateCheck({ quantity: 40, amount: 4218 * 0.95, price: 105.45 }).status, 'ok');
});

test('a rate well above the price is flagged HIGH, with how far', () => {
  const r = rateCheck({ quantity: 40, amount: 5200, price: 105.45 });
  assert.deepEqual([r.status, r.rate, r.expected, r.diff, r.diffPct], ['high', 130, 4218, 982, 23.3]);
});

test('a rate well below the price is flagged LOW', () => {
  const r = rateCheck({ quantity: 40, amount: 3000, price: 105.45 });
  assert.deepEqual([r.status, r.rate, r.diff, r.diffPct], ['low', 75, -1218, -28.9]);
});

test('exactly at the tolerance is still fine; just past it is flagged', () => {
  assert.equal(TOLERANCE_PCT, 10);
  assert.equal(rateCheck({ quantity: 100, amount: 11000, price: 100 }).status, 'ok', '+10.0%');
  assert.equal(rateCheck({ quantity: 100, amount: 11010, price: 100 }).status, 'high', '+10.1%');
  assert.equal(rateCheck({ quantity: 100, amount: 9000, price: 100 }).status, 'ok', '-10.0%');
  assert.equal(rateCheck({ quantity: 100, amount: 8990, price: 100 }).status, 'low', '-10.1%');
});

test('a wider tolerance can be asked for', () => {
  assert.equal(rateCheck({ quantity: 100, amount: 12000, price: 100, tolerancePct: 25 }).status, 'ok');
  assert.equal(rateCheck({ quantity: 100, amount: 12000, price: 100, tolerancePct: 25 }).tolerancePct, 25);
});

test('no price set: the bill\'s own rate is still worked out, nothing is judged', () => {
  const r = rateCheck({ quantity: 40, amount: 4000, price: null });
  assert.deepEqual(r, { status: 'no_price', rate: 100, tolerancePct: 10 });
  assert.equal(rateCheck({ quantity: 40, amount: 4000, price: undefined }).status, 'no_price');
  assert.equal(rateCheck({ quantity: 40, amount: 4000, price: 0 }).status, 'no_price');
});

test('no litres, a tiny fill, or no amount: too little to judge', () => {
  assert.equal(MIN_QUANTITY, 1);
  for (const [q, a] of [[0, 4000], [null, 4000], [0.5, 60], [0.99, 100], [40, 0], [40, null], ['', '']]) {
    assert.equal(rateCheck({ quantity: q, amount: a, price: 100 }).status, 'no_quantity', `${q} / ${a}`);
  }
  assert.notEqual(rateCheck({ quantity: 1, amount: 100, price: 100 }).status, 'no_quantity', 'one litre is judged');
});

test('CNG and electric work the same way (per kg, per kWh)', () => {
  assert.equal(rateCheck({ quantity: 8, amount: 700, price: 87.5 }).status, 'ok');
  assert.equal(rateCheck({ quantity: 30, amount: 600, price: 10 }).status, 'high');
});
