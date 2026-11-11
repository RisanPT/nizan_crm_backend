// FUEL PRICES kept by hand (Accounts / fleet manager): what a litre of petrol or diesel costs, a kg of
// CNG, a kWh of electricity — each with the day that price starts. There is no free, dependable
// price feed for Kerala, so the people who buy the fuel keep these few numbers up to date.
//
// Used two ways:
//   • FILL-IN  — litres × the price gives the amount to put in the form;
//   • BILL CHECK — a fuel bill's own rate (amount ÷ litres) is held against the price in force on
//     the day. A rate well off it is FLAGGED for Accounts, never refused: premium fuel, a highway
//     pump or a mistyped litre figure all look like this and only a person can tell which.
//
// Pure — tests/fuelPrice.test.js.

import { isDay } from './istDate.js';

export const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'electric'];

/// What the quantity on a bill is counted in.
export const UNITS = { petrol: 'litre', diesel: 'litre', cng: 'kg', electric: 'kWh' };

/// How far a bill's rate may sit from the price before it is flagged, in percent (either way).
/// Pumps differ a little town to town; premium grades run roughly 8–12% above regular.
export const TOLERANCE_PCT = 10;

/// A fill smaller than this is too small to judge a rate from (amounts are whole rupees).
export const MIN_QUANTITY = 1;

const MAX_PRICE = 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/// A real calendar day written YYYY-MM-DD (not 2026-02-31).
const realDay = (s) => {
  if (!isDay(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/// The price-table fuel type for a vehicle's fuel type: a hybrid runs on petrol; "other" (or
/// nothing) has no price to hold a bill against.
export const priceTypeOf = (vehicleFuelType) => {
  const t = String(vehicleFuelType ?? '').toLowerCase();
  if (t === 'hybrid') return 'petrol';
  return FUEL_TYPES.includes(t) ? t : null;
};

/**
 * Checks and cleans what a client sent for a price.
 * @param {object} input     { fuelType, pricePerUnit, effectiveFrom, note }
 * @param {Array}  existing  the other prices (the one being edited left out)
 * @returns {{ error: string, conflict?: boolean } | { clean: object }}
 */
export const validatePrice = (input, existing = []) => {
  const fuelType = String(input.fuelType ?? '').toLowerCase();
  if (!FUEL_TYPES.includes(fuelType)) return { error: 'Choose a fuel: petrol, diesel, CNG or electric.' };

  const raw = input.pricePerUnit;
  const price = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(price) || price <= 0) {
    return { error: `Enter the price per ${UNITS[fuelType]} (more than 0).` };
  }
  if (price > MAX_PRICE) return { error: `That is more than ₹${MAX_PRICE} per ${UNITS[fuelType]} — check the price.` };

  const effectiveFrom = String(input.effectiveFrom ?? '').trim();
  if (!realDay(effectiveFrom)) return { error: 'The "from" date is not valid (YYYY-MM-DD).' };

  const note = String(input.note ?? '').trim();
  if (note.length > 200) return { error: 'The note is too long (200 characters at most).' };

  const clean = { fuelType, pricePerUnit: round2(price), effectiveFrom, note };
  const clash = existing.find((p) => p.fuelType === fuelType && p.effectiveFrom === effectiveFrom);
  if (clash) {
    return { error: `There is already a ${fuelType} price from that date (₹${clash.pricePerUnit}). Edit that one instead.`, conflict: true };
  }
  return { clean };
};

/// The price in force for [fuelType] on [dayKey] ('YYYY-MM-DD', IST): the latest one that started on
/// or before that day. Null when none had started yet — a bill from before the first price entered is
/// never held against a later one.
export const priceOn = (rows, fuelType, dayKey) =>
  (rows ?? [])
    .filter((p) => p.fuelType === fuelType && p.effectiveFrom <= dayKey)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;

/// The price in force today for each fuel (null where none is set): { petrol, diesel, cng, electric }.
export const currentPrices = (rows, dayKey) => Object.fromEntries(FUEL_TYPES.map((t) => [t, priceOn(rows, t, dayKey)]));

/// The amount for a quantity at a price, to the paisa — what the fill-in puts in the form.
export const suggestAmount = (quantity, price) => {
  const q = Number(quantity);
  const p = Number(price);
  if (!(q > 0) || !(p > 0)) return null;
  return round2(q * p);
};

/**
 * Holds a bill's rate against the price.
 * @param {object} o  { quantity (litres / kg / kWh), amount (₹ paid), price (₹ per unit, null = none set), tolerancePct }
 * @returns {{ status, rate?, price?, expected?, diff?, diffPct?, tolerancePct }}
 *   status  ok | high | low   (rate within / above / below the tolerance of the price)
 *           no_price          (no price in force for that fuel and day)
 *           no_quantity       (no quantity, or too little to judge, or no amount)
 */
export const rateCheck = ({ quantity, amount, price, tolerancePct = TOLERANCE_PCT }) => {
  const q = Number(quantity) || 0;
  const a = Number(amount) || 0;
  if (!(q >= MIN_QUANTITY) || !(a > 0)) return { status: 'no_quantity', tolerancePct };
  const rate = round2(a / q);
  if (price == null || !(Number(price) > 0)) return { status: 'no_price', rate, tolerancePct };
  const p = Number(price);
  const expected = round2(q * p);
  const diff = round2(a - expected);
  const diffPct = Math.round((a / q / p - 1) * 1000) / 10;
  const status = diffPct > tolerancePct ? 'high' : diffPct < -tolerancePct ? 'low' : 'ok';
  return { status, rate, price: p, expected, diff, diffPct, tolerancePct };
};
