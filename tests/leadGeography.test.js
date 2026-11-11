import test from 'node:test';
import assert from 'node:assert/strict';
import { DERIVED_KEYS, geographyFields, readDistrictInput, readPincodeInput } from '../utils/leadGeography.js';

const district = { _id: 'd1', name: 'Kozhikode', region: { _id: 'r1', name: 'Calicut' } };

test('no pincode sent: the lead\'s pincode is left alone', () => {
  assert.deepEqual(readPincodeInput({}), { present: false });
  assert.deepEqual(readPincodeInput({ name: 'x' }), { present: false });
  assert.deepEqual(readPincodeInput(null), { present: false });
  assert.deepEqual(readPincodeInput(undefined), { present: false });
});

test('an empty pincode sent means "clear it"', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.deepEqual(readPincodeInput({ pincode: empty }), { present: true, code: '' }, JSON.stringify(empty));
  }
});

test('a valid pincode is cleaned to its digits', () => {
  assert.deepEqual(readPincodeInput({ pincode: '673001' }), { present: true, code: '673001' });
  assert.deepEqual(readPincodeInput({ pincode: ' 673 001 ' }), { present: true, code: '673001' });
  assert.deepEqual(readPincodeInput({ pincode: 673001 }), { present: true, code: '673001' });
});

test('anything else sent as a pincode is refused with a plain message', () => {
  for (const bad of ['67300', '6730011', '073001', 'abc', 'N/A', '67300a']) {
    const r = readPincodeInput({ pincode: bad });
    assert.equal(r.present, true, bad);
    assert.equal(r.error, 'Enter a 6-digit pincode.', bad);
    assert.equal(r.code, undefined, bad);
  }
});

test('the district sent: absent, empty, or an id', () => {
  assert.deepEqual(readDistrictInput({}), { present: false, id: '' });
  assert.deepEqual(readDistrictInput(null), { present: false, id: '' });
  assert.deepEqual(readDistrictInput({ districtId: null }), { present: true, id: '' });
  assert.deepEqual(readDistrictInput({ districtId: '' }), { present: true, id: '' });
  assert.deepEqual(readDistrictInput({ districtId: ' abc ' }), { present: true, id: 'abc' });
});

test('a district gives the lead its region and both names', () => {
  assert.deepEqual(geographyFields(district), { districtId: 'd1', regionId: 'r1', district: 'Kozhikode', region: 'Calicut' });
});

test('no district clears all four', () => {
  const cleared = { districtId: null, regionId: null, district: '', region: '' };
  assert.deepEqual(geographyFields(null), cleared);
  assert.deepEqual(geographyFields(undefined), cleared);
});

test('a district whose region is missing leaves the region empty, never throws', () => {
  assert.deepEqual(geographyFields({ _id: 'd2', name: 'Lone' }), { districtId: 'd2', regionId: null, district: 'Lone', region: '' });
});

test('the region and the names are never the client\'s to set', () => {
  assert.deepEqual([...DERIVED_KEYS].sort(), ['district', 'region', 'regionId']);
});
