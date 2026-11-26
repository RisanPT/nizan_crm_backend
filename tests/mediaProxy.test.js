// Playing a Dropbox video through our server — the rules (utils/mediaProxy.js): node --test tests/mediaProxy.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyUpstream, dropboxFileUrl, isAllowedMediaHost, signMediaToken, verifyMediaToken, videoTypeFor, directPlayable } from '../utils/mediaProxy.js';

test('only Dropbox\'s own hosts are fetched from', () => {
  for (const h of ['dropbox.com', 'www.dropbox.com', 'DL.Dropbox.com', 'dl.dropboxusercontent.com', 'uc4a1.dl.dropboxusercontent.com']) assert.equal(isAllowedMediaHost(h), true, h);
  for (const h of ['evil.com', 'dropbox.com.evil.com', 'notdropbox.com', 'dropboxusercontent.com.attacker.io', '127.0.0.1', 'localhost', '']) assert.equal(isAllowedMediaHost(h), false, h);
});

test('a Dropbox share link becomes the file itself; folders, other sites and non-videos are refused', () => {
  assert.deepEqual(dropboxFileUrl('https://www.dropbox.com/scl/fi/abc123/Bridal%20Reel.mp4?rlkey=k1&st=s9&dl=0'), {
    url: 'https://www.dropbox.com/scl/fi/abc123/Bridal%20Reel.mp4?rlkey=k1&st=s9&raw=1',
    fileName: 'Bridal Reel.mp4',
  });
  assert.equal(dropboxFileUrl('https://www.dropbox.com/s/xyz/clip.MOV?dl=1#t=3').url, 'https://www.dropbox.com/s/xyz/clip.MOV?raw=1');
  assert.equal(dropboxFileUrl(' https://dl.dropboxusercontent.com/scl/fi/abc/clip.mp4?rlkey=k ').url, 'https://dl.dropboxusercontent.com/scl/fi/abc/clip.mp4?rlkey=k', 'the content host is left as it is');
  assert.match(dropboxFileUrl('https://www.dropbox.com/scl/fo/abc/folder?rlkey=k').error, /folder/);
  assert.match(dropboxFileUrl('https://www.dropbox.com/sh/abc/xyz').error, /folder/);
  assert.match(dropboxFileUrl('http://www.dropbox.com/s/x/clip.mp4').error, /https/);
  assert.match(dropboxFileUrl('https://example.com/clip.mp4').error, /Only Dropbox/);
  assert.match(dropboxFileUrl('https://www.dropbox.com/s/x/photo.jpg').error, /not a video/);
  assert.match(dropboxFileUrl('https://user:pw@www.dropbox.com/s/x/clip.mp4').error, /not a Dropbox file link/);
  assert.match(dropboxFileUrl('https://www.dropbox.com:8443/s/x/clip.mp4').error, /not a Dropbox file link/);
  assert.match(dropboxFileUrl('not a link').error, /not a link/);
  assert.match(dropboxFileUrl(undefined).error, /not a link/);
});

test('the signed stream token: only what we signed, only until it expires', () => {
  const now = 1_800_000_000_000;
  const url = 'https://www.dropbox.com/s/x/clip.mp4?raw=1';
  const t = signMediaToken(url, { secret: 's3', now, ttlMs: 1000 });
  assert.deepEqual(verifyMediaToken(t, { secret: 's3', now: now + 999 }), { url, expiresAt: now + 1000 });
  assert.equal(verifyMediaToken(t, { secret: 's3', now: now + 1000 }).error, 'expired');
  assert.equal(verifyMediaToken(t, { secret: 'other', now }).error, 'bad', 'another secret');
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'https://evil.com/x.mp4', e: now + 1e9 })).toString('base64url');
  assert.equal(verifyMediaToken(`${forged}.${s}`, { secret: 's3', now }).error, 'bad', 'a payload swapped under the signature');
  assert.equal(verifyMediaToken(`${p}.${s.slice(0, -2)}xx`, { secret: 's3', now }).error, 'bad');
  assert.equal(verifyMediaToken(`${p}.${s}.x`, { secret: 's3', now }).error, 'bad');
  assert.equal(verifyMediaToken('', { secret: 's3', now }).error, 'bad');
  assert.equal(verifyMediaToken(t, { secret: '', now }).error, 'bad', 'no secret, no stream');
  assert.throws(() => signMediaToken(url, { secret: '' }), /No secret/);
  // even a correctly signed token never names another site
  const evil = signMediaToken('https://evil.com/x.mp4', { secret: 's3', now });
  assert.equal(verifyMediaToken(evil, { secret: 's3', now }).error, 'bad');
});

test('the type a video goes with: Dropbox\'s when it is a video type, else from the extension', () => {
  assert.equal(videoTypeFor('clip.mp4', 'application/json'), 'video/mp4', 'Dropbox\'s wrong type (Firefox refuses it)');
  assert.equal(videoTypeFor('clip.mp4', 'application/binary'), 'video/mp4');
  assert.equal(videoTypeFor('clip.webm', ''), 'video/webm');
  assert.equal(videoTypeFor('clip.MOV', 'video/quicktime'), 'video/mp4', 'a .mov plays in more browsers as mp4');
  assert.equal(videoTypeFor('clip.mp4', 'video/mp4; charset=binary'), 'video/mp4');
  assert.equal(videoTypeFor('clip.ogv', 'video/ogg'), 'video/ogg');
  assert.equal(videoTypeFor('noext', ''), 'video/mp4');
});

test('Dropbox\'s answer in plain words: the file, a paused link, a deleted one, a private one, a page, Dropbox down', () => {
  assert.equal(classifyUpstream({ status: 200, contentType: 'video/mp4' }), null);
  assert.equal(classifyUpstream({ status: 206, contentType: 'application/json' }), null, 'a wrong type is still the file');
  assert.equal(classifyUpstream({ status: 416, contentType: 'text/plain' }), null);
  const c = (a) => classifyUpstream(a);
  assert.deepEqual([c({ status: 429 }).code, c({ status: 429 }).status], ['limit', 429]);
  assert.equal(c({ status: 200, contentType: 'text/html', body: '<h1>This link is temporarily disabled</h1>' }).code, 'limit');
  assert.equal(c({ status: 403, contentType: 'text/html', body: 'too much traffic' }).code, 'limit');
  assert.deepEqual([c({ status: 404 }).code, c({ status: 404 }).status], ['missing', 404]);
  assert.equal(c({ status: 410 }).code, 'missing');
  assert.equal(c({ status: 403 }).code, 'private');
  assert.equal(c({ status: 200, contentType: 'text/html; charset=utf-8', body: 'This link requires a password' }).code, 'private');
  assert.equal(c({ status: 200, contentType: 'text/html', body: '<html>Dropbox preview</html>' }).code, 'page');
  assert.deepEqual([c({ status: 503 }).code, c({ status: 503 }).status], ['dropbox_down', 502]);
  assert.equal(c({ status: 400 }).code, 'refused');
  assert.match(c({ status: 429 }).message, /opened too often/);
});

test('server.js mounts the stream BEFORE /api/marketing (whose router asks every request for a login — a <video> tag has none)', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const media = server.indexOf("app.use('/api/marketing/media'");
  const marketing = server.indexOf("app.use('/api/marketing',");
  assert.ok(media > 0 && marketing > 0, 'both mounted');
  assert.ok(media < marketing, 'the media mount comes first');
});

test('which videos may play straight from Dropbox: mp4, m4v and webm — a .mov goes through the relay (Dropbox sends it as quicktime)', () => {
  assert.deepEqual(['a.mp4', 'B.MP4', 'c.m4v', 'd.webm'].map(directPlayable), [true, true, true, true]);
  assert.deepEqual(['e.mov', 'f.ogv', 'g.jpg', 'noext', ''].map(directPlayable), [false, false, false, false, false]);
});
