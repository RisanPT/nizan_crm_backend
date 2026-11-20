import test from 'node:test';
import assert from 'node:assert/strict';
import { dropboxFolderLink, folderListing, folderMediaOf, folderPreviewUrl, folderProblemOf, folderSummary, folderZipUrl, innerPath, isDropboxFolderLink, pictureTypeOf, showableInApp } from '../utils/dropboxFolder.js';
import { signMediaToken, verifyMediaToken } from '../utils/mediaProxy.js';
import { headerJson } from '../services/dropbox.js';

// the link an artist sent on WhatsApp (shape only — the ids are made up)
const ARTIST = 'https://www.dropbox.com/scl/fo/abc123/AD9yKEY?rlkey=xyz789&st=3ix2&dl=0';

test('a folder link is recognised (new and old), kept with its rlkey, without dl; anything else is not a folder', () => {
  const f = dropboxFolderLink(ARTIST);
  assert.equal(f.url, 'https://www.dropbox.com/scl/fo/abc123/AD9yKEY?rlkey=xyz789&st=3ix2');
  assert.equal(dropboxFolderLink('https://dropbox.com/sh/abc/def?dl=0#x').url, 'https://dropbox.com/sh/abc/def');
  assert.ok(isDropboxFolderLink(ARTIST));
  for (const bad of ['https://www.dropbox.com/scl/fi/abc/clip.mp4?rlkey=x', 'http://www.dropbox.com/scl/fo/a/b', 'https://evil.com/scl/fo/a/b', 'https://dropbox.com.evil.com/sh/a/b', 'https://user:pw@www.dropbox.com/sh/a/b', 'https://www.dropbox.com:8443/sh/a/b', 'not a link', '', null]) {
    assert.ok(dropboxFolderLink(bad).error, `refused: ${bad}`);
  }
});

test('download all = the same link with dl=1; a file opened on the folder page keeps the rlkey', () => {
  assert.equal(folderZipUrl(ARTIST), 'https://www.dropbox.com/scl/fo/abc123/AD9yKEY?rlkey=xyz789&st=3ix2&dl=1');
  assert.equal(folderPreviewUrl(ARTIST, 'C0001.MP4'), 'https://www.dropbox.com/scl/fo/abc123/AD9yKEY?rlkey=xyz789&st=3ix2&preview=C0001.MP4');
  assert.equal(folderZipUrl('https://www.dropbox.com/scl/fi/a/b.mp4'), '');
});

test('a place inside the folder never climbs out of it', () => {
  assert.equal(innerPath(''), '');
  assert.equal(innerPath('/'), '');
  assert.equal(innerPath('', { allowRoot: false }), null);
  assert.equal(innerPath('/Day 1/C0001.MP4'), '/Day 1/C0001.MP4');
  for (const bad of ['C0001.MP4', '/../x', '/a/../b', '/a//b', '/a/./b', '/a\\b', '/a\u0000b', `/${'x'.repeat(1001)}`, '/a/']) assert.equal(innerPath(bad), null, `refused: ${JSON.stringify(bad).slice(0, 30)}`);
});

test('what each file is, and whether the app can show it itself', () => {
  assert.deepEqual(['C0001.MP4', 'IMG_1.HEIC', 'shot.jpg', 'notes.txt', 'clip.MTS'].map(folderMediaOf), ['video', 'picture', 'picture', 'other', 'video']);
  assert.deepEqual(['C0001.MP4', 'a.mov', 'clip.MTS', 'shot.JPG', 'IMG_1.HEIC', 'r.CR3'].map(showableInApp), [true, true, false, true, false, false]);
  assert.equal(pictureTypeOf('a.PNG'), 'image/png');
  assert.equal(pictureTypeOf('a.mp4'), null);
});

test('a listing: folders and files in the order the camera named them, counts and a summary', () => {
  const l = folderListing(
    [
      { '.tag': 'file', name: 'C0010.MP4', size: 2 * 1024 ** 3, client_modified: '2026-11-18T10:00:00Z' },
      { '.tag': 'file', name: 'C0002.MP4', size: 1024 ** 3 },
      { '.tag': 'folder', name: 'Stills' },
      { '.tag': 'file', name: 'IMG_1.jpg', size: 5 * 1024 ** 2 },
      { '.tag': 'file', name: 'notes.txt', size: 10 },
      { '.tag': 'deleted', name: 'gone.mp4' },
      { '.tag': 'file', name: '' },
    ],
    '/Day 1',
  );
  assert.deepEqual(l.folders, [{ name: 'Stills', path: '/Day 1/Stills' }]);
  assert.deepEqual(l.files.map((f) => [f.name, f.path, f.media, f.showable]), [
    ['C0002.MP4', '/Day 1/C0002.MP4', 'video', true],
    ['C0010.MP4', '/Day 1/C0010.MP4', 'video', true],
    ['IMG_1.jpg', '/Day 1/IMG_1.jpg', 'picture', true],
    ['notes.txt', '/Day 1/notes.txt', 'other', false],
  ]);
  assert.equal(l.files[1].modifiedAt, '2026-11-18T10:00:00Z');
  assert.deepEqual([l.videoCount, l.pictureCount], [2, 1]);
  assert.equal(l.summary, '2 videos · 1 picture · 1 other file · 1 folder · 3.0 GB');
  assert.equal(folderSummary({}), 'Empty folder');
  assert.equal(folderSummary({ folderCount: 2 }), '2 folders');
});

test("Dropbox's refusals become what the artist should do", () => {
  assert.equal(folderProblemOf('shared_link_access_denied/..').code, 'private');
  assert.match(folderProblemOf('shared_link_access_denied/..').message, /Anyone with this link can view/);
  assert.equal(folderProblemOf('shared_link_not_found/').code, 'missing');
  assert.equal(folderProblemOf('path/not_found/..').code, 'missing');
  assert.equal(folderProblemOf('shared_link_password_required').code, 'password');
  assert.equal(folderProblemOf('shared_link_expired/').code, 'expired');
  const other = folderProblemOf('something_new/...');
  assert.equal(other.code, 'other');
  assert.match(other.message, /something_new/);
});

test('a stream token can name a file inside a folder; a file token is unchanged; a forged path is refused', () => {
  const secret = 's3cret';
  const t = signMediaToken('https://www.dropbox.com/scl/fo/a/b?rlkey=x', { secret, path: '/C0001.MP4' });
  assert.deepEqual([verifyMediaToken(t, { secret }).url, verifyMediaToken(t, { secret }).path], ['https://www.dropbox.com/scl/fo/a/b?rlkey=x', '/C0001.MP4']);
  const plain = signMediaToken('https://www.dropbox.com/scl/fi/a/c.mp4?raw=1', { secret });
  assert.equal(verifyMediaToken(plain, { secret }).path, undefined);
  // the path is inside the signed part: changing it breaks the signature
  const [payload, sig] = t.split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const forged = `${Buffer.from(JSON.stringify({ ...body, p: '/other.mp4' })).toString('base64url')}.${sig}`;
  assert.equal(verifyMediaToken(forged, { secret }).error, 'bad');
});

test("Dropbox's argument header carries any file name as plain ASCII", () => {
  const h = headerJson({ url: 'u', path: '/Reveal · ദിയ.mp4' });
  assert.ok(/^[\x20-\x7e]*$/.test(h), h);
  assert.deepEqual(JSON.parse(h), { url: 'u', path: '/Reveal · ദിയ.mp4' });
});
