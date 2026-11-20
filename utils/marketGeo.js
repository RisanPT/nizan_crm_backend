// THE MARKETING DETAILS OF A LEAD — pure rules (services/leadMarkets.js does the database part; tests/marketGeo.test.js).
//
// A lead can say where the bride is (country → city), how to reach her (a WhatsApp number, an e-mail), what she can spend (a budget in
// the country's currency), the language she speaks, who referred her and which ad creative she came from. Everything is optional and
// nothing is guessed: a key that is not in the request leaves that field alone, a key sent empty clears it, a key sent wrong is refused
// in plain words. The country and city NAMES stored on a lead are worked out from the ids, never taken from the client — so a lead can
// never say "Dubai" while pointing at Mumbai.

const MAX_BUDGET = 1e12;

/// The markets the list starts with (the Functionality Map's own examples). Only ever added to an EMPTY list — after that the
/// marketing team owns the list.
export const DEFAULT_MARKETS = [
  { name: 'India', code: 'IN', dialCode: '+91', currency: 'INR', cities: [
    { name: 'Mumbai', state: 'Maharashtra' }, { name: 'Bangalore', state: 'Karnataka' }, { name: 'Delhi', state: 'Delhi' },
    { name: 'Chennai', state: 'Tamil Nadu' }, { name: 'Calicut', state: 'Kerala' }, { name: 'Kochi', state: 'Kerala' },
  ] },
  { name: 'UAE', code: 'AE', dialCode: '+971', currency: 'AED', cities: [{ name: 'Dubai' }, { name: 'Abu Dhabi' }, { name: 'Sharjah' }] },
  { name: 'Malaysia', code: 'MY', dialCode: '+60', currency: 'MYR', cities: [{ name: 'Kuala Lumpur' }, { name: 'Penang' }, { name: 'Johor' }] },
];

/// Words from a typed value: spaces collapsed, ends trimmed. '' for none.
export const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/// A country as an admin typed it → { value } or { error }.
export const readCountryForm = (body) => {
  const name = cleanName(body?.name);
  if (name.length < 2 || name.length > 60) return { error: 'Give the country a name (2 to 60 letters).' };
  const code = cleanName(body?.code).toUpperCase();
  if (code && !/^[A-Z]{2,3}$/.test(code)) return { error: 'The country code is 2 or 3 letters, like IN or AE.' };
  const dialCode = cleanName(body?.dialCode).replace(/\s+/g, '');
  if (dialCode && !/^\+\d{1,4}$/.test(dialCode)) return { error: 'The dialling code looks like +971.' };
  const currency = cleanName(body?.currency).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) return { error: 'The currency is 3 letters, like INR or AED.' };
  return { value: { name, code, dialCode, currency } };
};

/// A city as an admin typed it → { value } or { error }.
export const readCityForm = (body) => {
  const name = cleanName(body?.name);
  if (name.length < 2 || name.length > 60) return { error: 'Give the city a name (2 to 60 letters).' };
  const state = cleanName(body?.state);
  if (state.length > 60) return { error: 'The state or province is at most 60 letters.' };
  return { value: { name, state } };
};

/// An id in a request body: { present, id } — id '' when sent empty (clear it).
export const readIdInput = (body, key) => {
  if (!body || !(key in body)) return { present: false, id: '' };
  const raw = body[key];
  return { present: true, id: raw == null ? '' : String(raw).trim() };
};

/// A phone / WhatsApp number → { value } or { error }. Spaces and dashes are dropped, a leading + is kept; 7 to 15 digits.
export const readWhatsapp = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: '' };
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || /[^\d\s+\-().]/.test(text)) return { error: 'The WhatsApp number does not look right.' };
  return { value: `${text.startsWith('+') ? '+' : ''}${digits}` };
};

/// An e-mail → { value } or { error }.
export const readEmail = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return { value: '' };
  if (text.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) return { error: 'The e-mail address does not look right.' };
  return { value: text };
};

/// A budget → { value } (null = none) or { error }. Not negative, not absurd, whole paise at most.
export const readBudget = (raw) => {
  if (raw == null || String(raw).trim() === '') return { value: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET) return { error: 'The budget must be an amount of 0 or more.' };
  return { value: Math.round(n * 100) / 100 };
};

/// A 3-letter currency code → { value } ('' for none) or { error }.
export const readCurrency = (raw) => {
  const text = cleanName(raw).toUpperCase();
  if (!text) return { value: '' };
  return /^[A-Z]{3}$/.test(text) ? { value: text } : { error: 'The currency is 3 letters, like INR or AED.' };
};

/// A short free text (language, referral partner, creative) → { value } or { error }.
export const readShortText = (raw, max, label) => {
  const text = cleanName(raw);
  return text.length > max ? { error: `${label} is at most ${max} letters.` } : { value: text };
};

/// The plain fields of a lead's marketing details that are in [body]: only the keys that were sent, each cleaned.
/// → { set: { key: value }, error } — the first problem wins.
export const readMarketFields = (body) => {
  const set = {};
  const take = (key, reader) => {
    if (!body || !(key in body)) return null;
    const r = reader(body[key]);
    if (r.error) return r.error;
    set[key] = r.value;
    return null;
  };
  const error =
    take('whatsapp', readWhatsapp) ||
    take('email', readEmail) ||
    take('budget', readBudget) ||
    take('budgetCurrency', readCurrency) ||
    take('language', (v) => readShortText(v, 40, 'The language')) ||
    take('referralPartner', (v) => readShortText(v, 80, 'The referral partner')) ||
    take('creative', (v) => readShortText(v, 120, 'The creative'));
  return { set, error: error ?? undefined };
};

/// The lead's country / city fields for a chosen city and country (either may be null); all cleared when there is neither.
/// Names are the ones in the list, never the client's.
export const marketFields = (country, city) => ({
  countryId: country?._id ?? null,
  country: country?.name ? String(country.name) : '',
  cityId: city?._id ?? null,
  city: city?.name ? String(city.name) : '',
});

/// Keys the client must not decide: the names are derived from the ids.
export const DERIVED_MARKET_KEYS = ['country', 'city'];
