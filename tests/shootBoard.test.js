// Pure unit tests: node --test tests/shootBoard.test.js
// The Shoot Planner's moodboard, logistics and milestone dates; footage from works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moodboardKind, cleanMoodboardItems, addToMoodboard, removeFromMoodboard, relabelMoodboard, cleanLogistics, shiftMilestones, MAX_MOODBOARD } from '../utils/shootBoard.js';
import { footageFolderName, footageFolderPath, footageLinkInfo, sameFootageLink, footageState, footageDue, sizeLabel, footageFiles } from '../utils/workFootage.js';

test('moodboard: a picture shows, a video plays outside, anything else is a link', () => {
  assert.equal(moodboardKind('https://res.cloudinary.com/x/image/upload/v1/a.jpg'), 'image', 'a picture uploaded from the phone');
  assert.equal(moodboardKind('https://res.cloudinary.com/x/image/upload/v1/abc'), 'image', 'no extension, still an upload');
  assert.equal(moodboardKind('https://i.pinimg.com/736x/aa/bb.jpg'), 'image');
  assert.equal(moodboardKind('https://www.dropbox.com/scl/fi/x/look.PNG?dl=0'), 'image');
  assert.equal(moodboardKind('https://cdn.test/clip.mp4'), 'video');
  assert.equal(moodboardKind('https://www.pinterest.com/pin/123/'), 'link');
  assert.equal(moodboardKind('not a link'), 'link');
});

test('moodboard: items checked, added once each, past the most refused; removed; relabelled', () => {
  assert.equal(cleanMoodboardItems([]).ok, false);
  assert.equal(cleanMoodboardItems([{ url: 'javascript:x' }]).ok, false);
  const items = cleanMoodboardItems([{ url: 'https://i.pinimg.com/a.jpg', label: 'Look' }, 'https://www.pinterest.com/pin/1/']).value;
  assert.deepEqual(items.map((i) => i.kind), ['image', 'link']);
  const now = new Date('2026-11-19T05:00:00Z');
  const r = addToMoodboard([{ url: 'https://www.pinterest.com/pin/1/', label: 'Old' }], items, { byName: 'Shahala', now });
  assert.deepEqual([r.ok, r.added, r.skipped, r.list.length], [true, 1, 1, 2]);
  assert.deepEqual(r.list[1], { url: 'https://i.pinimg.com/a.jpg', label: 'Look', kind: 'image', addedByName: 'Shahala', addedAt: now });
  assert.equal(r.list[0].label, 'Old', 'the one already there keeps its label');
  const full = Array.from({ length: MAX_MOODBOARD }, (_, i) => ({ url: `https://x.test/${i}.jpg` }));
  const over = addToMoodboard(full, [{ url: 'https://x.test/new.jpg', kind: 'image' }]);
  assert.equal(over.ok, false);
  assert.match(over.message, /up to 60/);
  assert.deepEqual(removeFromMoodboard(r.list, 'https://i.pinimg.com/a.jpg').removed, 1);
  assert.equal(removeFromMoodboard(r.list, 'https://nope').removed, 0);
  assert.equal(relabelMoodboard(r.list, 'https://i.pinimg.com/a.jpg', ' Bride look  ')[1].label, 'Bride look');
});

test('logistics: call time HH:MM, a real map link, a checklist that remembers who ticked what', () => {
  assert.equal(cleanLogistics({ callTime: '7:30' }).field, 'callTime');
  assert.equal(cleanLogistics({ mapUrl: 'maps' }).field, 'mapUrl');
  const t1 = new Date('2026-11-19T05:00:00Z');
  const a = cleanLogistics({ callTime: '07:30', mapUrl: 'https://maps.app.goo.gl/x', checklist: [{ text: 'Ring light' }, { text: 'Bridal set', done: true }, { text: '  ' }] }, {}, { byName: 'Faies', now: t1 }).value;
  assert.deepEqual(a.checklist, [{ text: 'Ring light', done: false, byName: '', at: null }, { text: 'Bridal set', done: true, byName: 'Faies', at: t1 }]);
  const t2 = new Date('2026-11-19T06:00:00Z');
  const b = cleanLogistics({ checklist: [{ text: 'Ring light', done: true }, { text: 'Bridal set', done: true }] }, a, { byName: 'Ashique', now: t2 }).value;
  assert.deepEqual(b.checklist.map((c) => [c.byName, c.at]), [['Ashique', t2], ['Faies', t1]], 'a tick that did not change keeps who ticked it');
  assert.equal(b.callTime, '07:30', 'what was not sent stays');
  assert.equal(cleanLogistics({ checklist: Array.from({ length: 41 }, (_, i) => `x${i}`) }).ok, false);
});

test('milestones move with the shoot day; done ones stay', () => {
  const m = [{ key: 'brief', date: '2026-11-05', doneAt: new Date() }, { key: 'production', date: '2026-11-10', doneAt: null }, { key: 'distribution', date: null, doneAt: null }];
  assert.deepEqual(shiftMilestones(m, '2026-11-10', '2026-12-10').map((x) => x.date), ['2026-11-05', '2026-12-10', null]);
  assert.equal(shiftMilestones(m, '2026-11-10', '2026-11-10'), m, 'same day: unchanged');
  assert.deepEqual(shiftMilestones(m, '2026-11-10', '2026-11-08').map((x) => x.date), ['2026-11-05', '2026-11-08', null], 'earlier works too');
});

test('footage folder: named after the work the same way for everyone, safe for Dropbox, filed by month', () => {
  const b = { bookingNumber: 'BK-1234', customerName: 'Amina K / "Ammu"', service: 'Bridal Makeup.' };
  assert.equal(footageFolderName(b, '2026-11-18'), '2026-11-18 · BK-1234 · Amina K - -Ammu- · Bridal Makeup');
  assert.equal(footageFolderPath('/Team N Works/', b, '2026-11-18'), '/Team N Works/2026-11/2026-11-18 · BK-1234 · Amina K - -Ammu- · Bridal Makeup');
  assert.equal(footageFolderName({}, ''), 'Work');
  assert.ok(footageFolderName({ customerName: 'x'.repeat(300) }, '2026-11-18').length <= 120);
});

test('footage links: Dropbox (file or folder) or Google Drive only, said plainly otherwise; the same link with another query is the same', () => {
  assert.deepEqual(footageLinkInfo('https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1&dl=0'), { ok: true, url: 'https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1&dl=0', provider: 'dropbox', kind: 'folder' });
  assert.equal(footageLinkInfo('https://www.dropbox.com/scl/fi/abc/clip.mp4?dl=0').kind, 'file');
  assert.equal(footageLinkInfo('https://www.dropbox.com/s/abc/clip.mp4').kind, 'file');
  assert.equal(footageLinkInfo('https://drive.google.com/drive/folders/1abc').provider, 'drive');
  assert.match(footageLinkInfo('https://www.dropbox.com/pricing').message, /file or a folder/);
  assert.match(footageLinkInfo('https://wetransfer.com/x').message, /Only Dropbox/);
  assert.equal(footageLinkInfo('http://www.dropbox.com/s/a/b').ok, false);
  assert.equal(footageLinkInfo('').ok, false);
  assert.equal(sameFootageLink('https://www.dropbox.com/s/a/b?dl=0', 'https://WWW.dropbox.com/s/a/b/?dl=1'), true);
});

test('footage state and due: waiting until something is in; due once the day has come for a work that needs content', () => {
  assert.equal(footageState(null), 'waiting');
  assert.equal(footageState({ links: [{ url: 'x' }], status: 'in_edit' }), 'in_edit');
  assert.equal(footageState({ files: [{ name: 'a' }] }), 'new');
  assert.equal(footageDue({ needsContent: true, day: '2026-11-18', today: '2026-11-18', rec: null }), true);
  assert.equal(footageDue({ needsContent: true, day: '2026-11-19', today: '2026-11-18', rec: null }), false, 'not before the work');
  assert.equal(footageDue({ needsContent: false, day: '2026-11-17', today: '2026-11-18', rec: null }), false);
  assert.equal(footageDue({ needsContent: true, day: '2026-11-17', today: '2026-11-18', rec: { links: [{ url: 'x' }] } }), false);
});

test('a Dropbox listing: the files newest first and their size; sizes in words', () => {
  const f = footageFiles([{ '.tag': 'folder', name: 'sub' }, { '.tag': 'file', name: 'a.mp4', path_display: '/W/a.mp4', size: 600 * 1024 * 1024, client_modified: '2026-11-18T10:00:00Z' }, { '.tag': 'file', name: 'b.mov', path_display: '/W/b.mov', size: 1024 ** 3, client_modified: '2026-11-18T11:00:00Z' }]);
  assert.deepEqual(f.files.map((x) => x.name), ['b.mov', 'a.mp4']);
  assert.equal(sizeLabel(f.totalBytes), '1.6 GB');
  assert.equal(sizeLabel(820 * 1024 * 1024), '820 MB');
  assert.equal(sizeLabel(0), '');
});

test('the storyboard: a new frame gets a key and no tick; an edit keeps the tick of a frame that stays, never one it sends', async () => {
  const { mergeStoryboard } = await import('../utils/shootBoard.js');
  let n = 0;
  const makeKey = () => `key${(n += 1)}`;
  const first = mergeStoryboard([], [{ description: 'Walk in' }, { description: 'Eyes' }], { makeKey });
  assert.deepEqual(first.map((f) => [f.key, f.shotAt, f.shotByName]), [['key1', null, ''], ['key2', null, '']]);
  const saved = [{ ...first[0], shotAt: new Date('2026-11-20T05:00:00Z'), shotByName: 'Ashique' }, first[1]];
  // reordered, edited, one frame added — and a forged tick on a frame that was not shot is ignored
  const next = mergeStoryboard(saved, [{ key: 'key2', description: 'Eyes, slow', shotAt: '2020-01-01', shotByName: 'Me' }, { key: 'key1', description: 'Walk in (wide)' }, { description: 'Jewellery' }], { makeKey });
  assert.deepEqual(next.map((f) => [f.key, f.description, f.shotByName, !!f.shotAt]), [['key2', 'Eyes, slow', '', false], ['key1', 'Walk in (wide)', 'Ashique', true], ['key3', 'Jewellery', '', false]]);
  // a key sent twice, or one not on the board, is not trusted: a fresh one
  const dup = mergeStoryboard(saved, [{ key: 'key1', description: 'a' }, { key: 'key1', description: 'b' }, { key: 'made-up-key', description: 'c' }], { makeKey });
  assert.deepEqual(dup.map((f) => [f.key, f.shotByName]), [['key1', 'Ashique'], ['key4', ''], ['key5', '']]);
});

test('frames saved before keys get one each; "6 of 9 shot"', async () => {
  const { withFrameKeys, shotProgress } = await import('../utils/shootBoard.js');
  let n = 0;
  const r = withFrameKeys([{ description: 'a' }, { key: 'k', description: 'b' }, { key: 'k', description: 'c' }], { makeKey: () => `n${(n += 1)}` });
  assert.equal(r.changed, true);
  assert.deepEqual(r.frames.map((f) => f.key), ['n1', 'k', 'n2']);
  assert.equal(withFrameKeys([{ key: 'a' }, { key: 'b' }]).changed, false);
  assert.deepEqual(shotProgress([{ shotAt: new Date() }, {}, { shotAt: new Date() }]), { total: 3, shot: 2, pct: 67 });
  assert.deepEqual(shotProgress([]), { total: 0, shot: 0, pct: 0 });
});

test('the checklist holds each line once (a line is ticked by its text)', async () => {
  const { cleanLogistics } = await import('../utils/shootBoard.js');
  const v = cleanLogistics({ checklist: ['Ring light', { text: 'ring light', done: true }, 'Steamer', '  '] }, {});
  assert.deepEqual(v.value.checklist.map((c) => c.text), ['Ring light', 'Steamer']);
});

test('an uploaded PDF\'s name reads right: UTF-8 the form reader took for Latin-1 is read back; a real Latin-1 name stays', async () => {
  const { pdfName, utf8Name } = await import('../utils/shootBoard.js');
  const { storageName } = await import('../services/shootFiles.js');
  const asReceived = (s) => Buffer.from(s, 'utf8').toString('latin1');
  assert.equal(pdfName(asReceived('Marketing Department Flow · Team N Makeovers.pdf')), 'Marketing Department Flow · Team N Makeovers.pdf');
  assert.equal(pdfName(asReceived('ദിയ storyboard')), 'ദിയ storyboard.pdf');
  assert.equal(utf8Name('Café brief.pdf'), 'Café brief.pdf', 'already right: kept');
  assert.equal(utf8Name('plain.pdf'), 'plain.pdf');
  // where Cloudinary files it: plain characters only (the shown name is kept apart)
  assert.equal(storageName('Marketing Department Flow · Team N Makeovers.pdf'), 'Marketing_Department_Flow_Team_N_Makeovers');
  assert.equal(storageName('ദിയ.pdf'), 'document');
});
