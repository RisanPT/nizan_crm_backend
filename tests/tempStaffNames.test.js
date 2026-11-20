import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, editDistance, isPending, keyOf, looksLikeSame, parseTempStaff } from '../utils/tempStaffNames.js';

// Reading the old free-text "temporary staff" box — the strings are shaped like the real ones.
const people = (text) => parseTempStaff(text).map((p) => [p.name, p.role].filter(Boolean).join('|'));

test('a plain first name is one person; the text is read case- and space-insensitively', () => {
  assert.deepEqual(people('reem'), ['Reem']);
  assert.deepEqual(people('  REEM  '), ['Reem']);
  assert.deepEqual(people('moni chechi'), ['Moni Chechi']);
  assert.equal(keyOf('Moni Chechi'), keyOf('monichechi'), 'one key for both spellings of the space');
  assert.equal(parseTempStaff('moni chechi')[0].key, 'monichechi');
});

test('several names: & / and / + / , / ; / a new line each start a person', () => {
  assert.deepEqual(people('hiba & thasliya'), ['Hiba', 'Thasliya']);
  assert.deepEqual(people('shebina and shabana'), ['Shebina', 'Shabana']);
  assert.deepEqual(people('arun + zeena'), ['Arun', 'Zeena']);
  assert.deepEqual(people('nedha, aswani; fidha'), ['Nedha', 'Aswani', 'Fidha']);
  assert.deepEqual(people('ani \nthasliya'), ['Ani', 'Thasliya']);
});

test('"and" inside a name is not a separator ("Anand"), only the word', () => {
  assert.deepEqual(people('anand and brinda'), ['Anand', 'Brinda']);
});

test('roles are taken out of the name and kept as a hint: draping, makeup, hair — however they were spelled', () => {
  assert.deepEqual(people('ajila saree drapist'), ['Ajila|Saree draping']);
  assert.deepEqual(people('akhila drapiest'), ['Akhila|Saree draping']);
  assert.deepEqual(people('ani saree draping'), ['Ani|Saree draping']);
  assert.deepEqual(people('lijina makeup artist'), ['Lijina|Makeup']);
  assert.deepEqual(people('lijina make up'), ['Lijina|Makeup']);
  assert.deepEqual(people('divya hair'), ['Divya|Hair']);
  assert.deepEqual(people('siniya (makeup) and reshma(saree)'), ['Siniya|Makeup', 'Reshma|Saree draping']);
});

test('a role that ends the text belongs to every name before it; one in the middle only to its own', () => {
  assert.deepEqual(people('hiba and akhila drapist'), ['Hiba|Saree draping', 'Akhila|Saree draping']);
  assert.deepEqual(people('muneera & risvana saree drapist'), ['Muneera|Saree draping', 'Risvana|Saree draping']);
  assert.deepEqual(people('reshma saree drapist & thesliaya'), ['Reshma|Saree draping', 'Thesliaya']);
});

test('filler ("for 1st look") and ordinals are dropped; a phone number is kept apart from the name', () => {
  assert.deepEqual(people('ani  for 1 st look \nthasliya for 2nd look'), ['Ani', 'Thasliya']);
  const [p] = parseTempStaff('drishya  8012345604');
  assert.deepEqual([p.name, p.phone], ['Drishya', '8012345604']);
  assert.equal(parseTempStaff('drishya').at(0).phone, '');
});

test('text that names nobody gives nobody: blank, only a role, "needed", "nil", one letter, only digits', () => {
  for (const t of ['', '   ', null, undefined, 'saree draping', '2 assistants needed', 'need 1 extra staff', 'nil', 'N/A', 'a', '123']) {
    assert.deepEqual(parseTempStaff(t), [], JSON.stringify(t));
  }
});

test('the same person twice in one text is listed once', () => {
  assert.deepEqual(people('reem & Reem'), ['Reem']);
});

test('letters from other scripts are names too, vowel signs and all', () => {
  assert.deepEqual(people('റീം & ഹിബ'), ['റീം', 'ഹിബ']);
  assert.equal(keyOf('ഹിബ'), 'ഹിബ');
});

test('looksLikeSame: one letter apart AND long enough to be a typo — never merged on its own', () => {
  assert.equal(editDistance('thesliya', 'thasliya'), 1);
  assert.equal(looksLikeSame('thesliya', 'thasliya'), true);
  assert.equal(looksLikeSame('thesliya', 'thesliaya'), true);
  assert.equal(looksLikeSame('aswini', 'aswani'), true);
  assert.equal(looksLikeSame('nida', 'nidha'), false, 'too short to be sure');
  assert.equal(looksLikeSame('hiba', 'hiba'), false, 'the same key is the same row, not a lookalike');
  assert.equal(looksLikeSame('shahana', 'rizwana'), false);
  assert.equal(editDistance('', 'ab'), 2);
});

const bk = (id, text, extra = {}) => ({ _id: id, temporaryStaffDetails: text, status: 'completed', bookingNumber: `BK-${id}`, customerName: `Bride ${id}`, selectedDates: ['2026-10-12T00:00:00.000Z'], ...extra });

test('isPending: blank box, a dead work, or this exact text already converted are not offered; an edited text is', () => {
  assert.equal(isPending(bk(1, 'reem')), true);
  assert.equal(isPending(bk(1, '  ')), false);
  assert.equal(isPending(bk(1, '')), false);
  for (const status of ['cancelled', 'canceled', 'rejected', 'lost', 'Cancelled']) assert.equal(isPending(bk(1, 'reem', { status })), false, status);
  assert.equal(isPending(bk(1, 'reem', { status: 'confirmed' })), true);
  assert.equal(isPending(bk(1, 'reem', { tempStaffConverted: { text: 'reem' } })), false);
  assert.equal(isPending(bk(1, 'reem & hiba', { tempStaffConverted: { text: 'reem' } })), true, 'the text changed after converting');
});

test('buildRows: one row per person across the bookings, with count, spellings, role hint, phone, samples', () => {
  const { pendingBookings, rows } = buildRows([
    bk(1, 'thesliya'),
    bk(2, 'thesliya & reem'),
    bk(3, 'ajila saree drapist'),
    bk(4, 'ajila saree draping'),
    bk(5, 'ajila'),
    bk(6, 'Reem  8012345604'),
    bk(7, 'ignored', { status: 'cancelled' }),
    bk(8, ''),
    bk(9, '2 assistants needed'),
  ]);
  assert.equal(pendingBookings, 6, 'not the cancelled one, the blank one, or the text that names nobody');
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(by).sort(), ['ajila', 'reem', 'thesliya']);
  assert.equal(by.thesliya.count, 2);
  assert.equal(by.reem.count, 2);
  assert.equal(by.reem.phone, '8012345604');
  assert.equal(by.ajila.count, 3);
  assert.equal(by.ajila.roleHint, 'Saree draping');
  assert.equal(by.ajila.samples.length, 3);
  assert.deepEqual(by.ajila.samples[0], { bookingId: '3', bookingNumber: 'BK-3', customerName: 'Bride 3', day: '2026-10-12', text: 'ajila saree drapist' });
  assert.deepEqual(rows.map((r) => r.key), ['ajila', 'reem', 'thesliya'], 'most bookings first, then by name');
});

test('buildRows: the most common spelling names the row; lookalike spellings stay separate rows but point at each other', () => {
  const { rows } = buildRows([bk(1, 'thesliya'), bk(2, 'thesliya'), bk(3, 'thasliya'), bk(4, 'thesliaya'), bk(5, 'nida'), bk(6, 'nidha')]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(Object.keys(by).length, 5, 'never merged on its own');
  assert.deepEqual(by.thesliya.similar.sort(), ['thasliya', 'thesliaya']);
  assert.deepEqual(by.thasliya.similar, ['thesliya']);
  assert.deepEqual(by.nida.similar, [], 'too short to suggest');
});

test('buildRows: a name that is already a registered associate is suggested as a link (exact, or a lookalike)', () => {
  const { rows } = buildRows([bk(1, 'asha'), bk(2, 'thasliya'), bk(3, 'zeena')], [{ _id: 'e1', name: 'Asha' }, { _id: 'e2', name: 'Thesliya' }]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(by.asha.suggestion, { employeeId: 'e1', name: 'Asha', exact: true });
  assert.deepEqual(by.thasliya.suggestion, { employeeId: 'e2', name: 'Thesliya', exact: false });
  assert.equal(by.zeena.suggestion, null);
});
