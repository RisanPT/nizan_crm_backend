import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MARKETS, DERIVED_MARKET_KEYS, cleanName, marketFields, readBudget, readCityForm, readCountryForm, readCurrency, readEmail,
  readIdInput, readMarketFields, readShortText, readWhatsapp,
} from '../utils/marketGeo.js';

test('the starting list has the Functionality Map\'s own markets, each city once', () => {
  assert.deepEqual(DEFAULT_MARKETS.map((m) => m.name), ['India', 'UAE', 'Malaysia']);
  const find = (n) => DEFAULT_MARKETS.find((m) => m.name === n).cities.map((c) => c.name);
  assert.ok(['Mumbai', 'Bangalore', 'Delhi', 'Chennai', 'Calicut'].every((c) => find('India').includes(c)));
  assert.deepEqual(find('UAE'), ['Dubai', 'Abu Dhabi', 'Sharjah']);
  assert.deepEqual(find('Malaysia'), ['Kuala Lumpur', 'Penang', 'Johor']);
  for (const m of DEFAULT_MARKETS) {
    assert.match(m.currency, /^[A-Z]{3}$/);
    assert.match(m.dialCode, /^\+\d{1,4}$/);
    assert.equal(new Set(m.cities.map((c) => c.name.toLowerCase())).size, m.cities.length, `${m.name} repeats a city`);
    assert.equal(readCountryForm(m).error, undefined, m.name);
  }
});

test('words are cleaned: spaces collapsed, ends trimmed', () => {
  assert.equal(cleanName('  Abu   Dhabi '), 'Abu Dhabi');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
});

test('a country form: name needed, code / dial code / currency in their shapes', () => {
  assert.deepEqual(readCountryForm({ name: ' UAE ', code: 'ae', dialCode: '+971', currency: 'aed' }).value, { name: 'UAE', code: 'AE', dialCode: '+971', currency: 'AED' });
  assert.deepEqual(readCountryForm({ name: 'Oman' }).value, { name: 'Oman', code: '', dialCode: '', currency: '' });
  assert.match(readCountryForm({ name: 'X' }).error, /name/);
  assert.match(readCountryForm({ name: '' }).error, /name/);
  assert.match(readCountryForm({ name: 'A'.repeat(61) }).error, /name/);
  assert.match(readCountryForm({ name: 'Oman', code: 'O1' }).error, /code/);
  assert.match(readCountryForm({ name: 'Oman', dialCode: '968' }).error, /dialling/);
  assert.match(readCountryForm({ name: 'Oman', currency: 'RIAL' }).error, /currency/);
});

test('a city form: name needed, state optional', () => {
  assert.deepEqual(readCityForm({ name: ' Dubai ', state: ' ' }).value, { name: 'Dubai', state: '' });
  assert.deepEqual(readCityForm({ name: 'Calicut', state: 'Kerala' }).value, { name: 'Calicut', state: 'Kerala' });
  assert.match(readCityForm({ name: 'D' }).error, /name/);
  assert.match(readCityForm({ name: 'Dubai', state: 'S'.repeat(61) }).error, /state/);
});

test('an id key: absent leaves alone, sent empty clears', () => {
  assert.deepEqual(readIdInput({}, 'cityId'), { present: false, id: '' });
  assert.deepEqual(readIdInput(null, 'cityId'), { present: false, id: '' });
  assert.deepEqual(readIdInput({ cityId: null }, 'cityId'), { present: true, id: '' });
  assert.deepEqual(readIdInput({ cityId: '' }, 'cityId'), { present: true, id: '' });
  assert.deepEqual(readIdInput({ cityId: ' abc ' }, 'cityId'), { present: true, id: 'abc' });
});

test('WhatsApp numbers: cleaned, + kept, 7 to 15 digits, junk refused', () => {
  assert.equal(readWhatsapp('').value, '');
  assert.equal(readWhatsapp(null).value, '');
  assert.equal(readWhatsapp('+971 50 123 4567').value, '+971501234567');
  assert.equal(readWhatsapp('98765-43210').value, '9876543210');
  assert.equal(readWhatsapp('(044) 2345 6789').value, '04423456789');
  for (const bad of ['12345', '1'.repeat(16), 'call me', '98765 4321x']) assert.match(readWhatsapp(bad).error, /WhatsApp/, bad);
});

test('e-mails: simple shape, empty allowed', () => {
  assert.equal(readEmail('').value, '');
  assert.equal(readEmail('  bride@example.com ').value, 'bride@example.com');
  for (const bad of ['bride', 'bride@', '@example.com', 'a b@example.com', 'a@b', `${'x'.repeat(120)}@example.com`]) assert.match(readEmail(bad).error, /e-mail/, bad);
});

test('budgets: empty = none, numbers cleaned, negative / absurd / words refused', () => {
  assert.equal(readBudget('').value, null);
  assert.equal(readBudget(null).value, null);
  assert.equal(readBudget(undefined).value, null);
  assert.equal(readBudget('1,20,000').value, 120000);
  assert.equal(readBudget(85000).value, 85000);
  assert.equal(readBudget('0').value, 0);
  assert.equal(readBudget('1234.567').value, 1234.57);
  for (const bad of ['-1', -5, 'lots', NaN, Infinity, 1e13, '1e13']) assert.match(readBudget(bad).error, /budget/, String(bad));
});

test('currencies: 3 letters, upper-cased, empty allowed', () => {
  assert.equal(readCurrency('aed').value, 'AED');
  assert.equal(readCurrency('').value, '');
  assert.equal(readCurrency(null).value, '');
  assert.match(readCurrency('rupee').error, /currency/);
  assert.match(readCurrency('A1B').error, /currency/);
});

test('short texts: collapsed, capped', () => {
  assert.equal(readShortText('  Reel   #17 ', 120, 'The creative').value, 'Reel #17');
  assert.match(readShortText('x'.repeat(41), 40, 'The language').error, /language.*40/);
});

test('market fields: only the keys that were sent, each cleaned; the first problem wins', () => {
  assert.deepEqual(readMarketFields({ name: 'Anu', phone: '9' }), { set: {}, error: undefined });
  assert.deepEqual(readMarketFields(null), { set: {}, error: undefined });
  const r = readMarketFields({ whatsapp: '+971 50 123 4567', email: ' a@b.co ', budget: '1,50,000', budgetCurrency: 'inr', language: 'Malayalam', referralPartner: ' Aysha  Weddings ', creative: 'Reel #17' });
  assert.deepEqual(r.set, { whatsapp: '+971501234567', email: 'a@b.co', budget: 150000, budgetCurrency: 'INR', language: 'Malayalam', referralPartner: 'Aysha Weddings', creative: 'Reel #17' });
  assert.equal(r.error, undefined);
  // sent empty = cleared
  assert.deepEqual(readMarketFields({ whatsapp: '', budget: null, language: '' }).set, { whatsapp: '', budget: null, language: '' });
  // first problem wins, nothing half-applied matters because the caller throws
  assert.match(readMarketFields({ whatsapp: 'x', email: 'bad' }).error, /WhatsApp/);
  assert.match(readMarketFields({ email: 'bad', budget: '-1' }).error, /e-mail/);
  assert.match(readMarketFields({ budget: '-1' }).error, /budget/);
});

test('country and city fields come from the list, and clear together', () => {
  const country = { _id: 'c1', name: 'UAE' };
  const city = { _id: 'k1', name: 'Dubai' };
  assert.deepEqual(marketFields(country, city), { countryId: 'c1', country: 'UAE', cityId: 'k1', city: 'Dubai' });
  assert.deepEqual(marketFields(country, null), { countryId: 'c1', country: 'UAE', cityId: null, city: '' });
  assert.deepEqual(marketFields(null, null), { countryId: null, country: '', cityId: null, city: '' });
});

test('the names are derived, so the client may not set them', () => {
  assert.deepEqual([...DERIVED_MARKET_KEYS].sort(), ['city', 'country']);
});
