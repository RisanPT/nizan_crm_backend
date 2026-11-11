import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLookup, districtKey, isValidPincode, matchDistrict, normalizePincode, placeOfDistrict } from '../utils/pincodeLookup.js';

const zone = { _id: 'z1', name: 'South' };
const state = { _id: 's1', name: 'Kerala', zone };
const region = { _id: 'r1', name: 'Calicut', state };
const kozhikode = { _id: 'd1', name: 'Kozhikode', region };
const wayanad = { _id: 'd2', name: 'Wayanad', region };

test('a pincode as typed is reduced to its digits', () => {
  assert.equal(normalizePincode('673 001'), '673001');
  assert.equal(normalizePincode(' 673-001 '), '673001');
  assert.equal(normalizePincode(null), '');
  assert.equal(normalizePincode(undefined), '');
  assert.equal(normalizePincode(673001), '673001');
});

test('six digits, not starting with 0, is a pincode', () => {
  for (const ok of ['673001', '110001', '999999']) assert.equal(isValidPincode(ok), true, ok);
  for (const bad of ['', '67300', '6730011', '073001', '67300a', ' 673001', null, undefined]) assert.equal(isValidPincode(bad), false, String(bad));
});

test('district names compare without "district", punctuation or case', () => {
  assert.equal(districtKey('Kozhikode District'), 'kozhikode');
  assert.equal(districtKey('  KOZHIKODE '), 'kozhikode');
  assert.equal(districtKey('Thiruvananthapuram'), 'thiruvananthapuram');
  assert.equal(districtKey(''), '');
  assert.equal(districtKey(null), '');
});

test('the old and new names of a district are the same district', () => {
  assert.equal(districtKey('Calicut'), districtKey('Kozhikode'));
  assert.equal(districtKey('Trivandrum'), districtKey('Thiruvananthapuram'));
  assert.equal(districtKey('Alleppey'), districtKey('Alappuzha'));
  assert.equal(districtKey('Palghat'), districtKey('Palakkad'));
  assert.equal(districtKey('Cannanore'), districtKey('Kannur'));
  assert.equal(districtKey('Quilon'), districtKey('Kollam'));
  assert.equal(districtKey('Trichur'), districtKey('Thrissur'));
});

test('a place lookup\'s district name finds our district', () => {
  assert.equal(matchDistrict('Kozhikode District', [wayanad, kozhikode]), kozhikode);
  assert.equal(matchDistrict('Calicut', [wayanad, kozhikode]), kozhikode);
});

test('no match, an empty name, or two districts of that name → no guess', () => {
  assert.equal(matchDistrict('Idukki', [wayanad, kozhikode]), null);
  assert.equal(matchDistrict('', [wayanad, kozhikode]), null);
  assert.equal(matchDistrict(undefined, [wayanad]), null);
  assert.equal(matchDistrict('Kozhikode', []), null);
  assert.equal(matchDistrict('Kozhikode', undefined), null);
  const twin = { _id: 'd9', name: 'Kozhikode', region: { _id: 'r9', name: 'Other', state } };
  assert.equal(matchDistrict('Kozhikode', [kozhikode, twin]), null, 'two candidates is ambiguous');
});

test('a district\'s place is its whole chain as { id, name }', () => {
  assert.deepEqual(placeOfDistrict(kozhikode), {
    district: { id: 'd1', name: 'Kozhikode' },
    region: { id: 'r1', name: 'Calicut' },
    state: { id: 's1', name: 'Kerala' },
    zone: { id: 'z1', name: 'South' },
  });
});

test('a district whose chain is cut short leaves the rest empty, never throws', () => {
  const lone = { _id: 'd3', name: 'Lone' };
  assert.deepEqual(placeOfDistrict(lone), { district: { id: 'd3', name: 'Lone' }, region: null, state: null, zone: null });
  assert.deepEqual(placeOfDistrict(null), { district: null, region: null, state: null, zone: null });
  const noState = { _id: 'd4', name: 'NoState', region: { _id: 'r4', name: 'R4', state: null } };
  assert.equal(placeOfDistrict(noState).state, null);
  assert.equal(placeOfDistrict(noState).zone, null);
});

test('in our list: answered from the list, with the coordinates when cached', () => {
  const r = buildLookup({ code: '673001', master: { status: 'active', district: kozhikode }, geo: { lat: 11.25, lng: 75.78, label: 'Kozhikode' } });
  assert.deepEqual(
    [r.valid, r.found, r.source, r.active, r.district.name, r.region.name, r.state.name, r.zone.name, r.area, r.lat, r.lng],
    [true, true, 'master', true, 'Kozhikode', 'Calicut', 'Kerala', 'South', 'Kozhikode', 11.25, 75.78],
  );
});

test('in our list but not yet located: no coordinates, still found', () => {
  const r = buildLookup({ code: '673001', master: { status: 'active', district: kozhikode } });
  assert.deepEqual([r.found, r.source, r.lat, r.lng, r.area], [true, 'master', null, null, '']);
});

test('in our list but marked inactive: found, flagged inactive', () => {
  const r = buildLookup({ code: '673001', master: { status: 'inactive', district: kozhikode } });
  assert.deepEqual([r.found, r.source, r.active], [true, 'master', false]);
});

test('not in our list: the place lookup\'s district is only a suggestion', () => {
  const r = buildLookup({ code: '673999', geo: { lat: 11.3, lng: 75.8, label: 'Elathur' }, suggested: kozhikode });
  assert.deepEqual([r.found, r.source, r.district.name, r.region.name, r.area, r.lat], [true, 'geocode', 'Kozhikode', 'Calicut', 'Elathur', 11.3]);
});

test('not in our list and no district matches: nothing is made up, the area still shows', () => {
  const r = buildLookup({ code: '999999', geo: { lat: 1, lng: 2, label: 'Somewhere' } });
  assert.deepEqual([r.found, r.source, r.district, r.region, r.state, r.zone, r.area, r.lat], [false, 'none', null, null, null, null, 'Somewhere', 1]);
});

test('nothing known at all', () => {
  const r = buildLookup({ code: '999999' });
  assert.deepEqual([r.valid, r.found, r.source, r.area, r.lat, r.lng], [true, false, 'none', '', null, null]);
});

test('our list wins over a differing place lookup', () => {
  const r = buildLookup({ code: '673001', master: { status: 'active', district: kozhikode }, geo: { lat: 1, lng: 2, label: 'X' }, suggested: wayanad });
  assert.deepEqual([r.source, r.district.name], ['master', 'Kozhikode']);
});
