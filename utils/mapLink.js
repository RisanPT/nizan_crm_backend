// Reads a location out of whatever staff paste into a booking's "Map URL /
// Coordinates" field:
//   • plain coordinates            11.2588, 75.7804
//   • full Google Maps links       …/@11.25,75.78,17z   …?q=11.25,75.78
//                                  …!3d11.25!4d75.78    …?query= / ll= / destination=
//   • short share links            maps.app.goo.gl/…  goo.gl/maps/…  (followed
//     on the server — ONLY Google hosts, so this can't be used to fetch
//     arbitrary URLs from the server's network)
//   • links that carry a place name instead of coordinates (…?q=Hotel+Raviz)
//     → returned as { query } for the caller to look up by name.

import dns from 'dns';
import https from 'https';

const ALLOWED_HOSTS = [
  /^maps\.app\.goo\.gl$/i,
  /^goo\.gl$/i,
  /^(www\.|maps\.)?google\.[a-z.]+$/i,
];
const MAX_HOPS = 5;

const valid = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PATTERNS = [
  new RegExp(`!3d${NUM}!4d${NUM}`), // exact place pin — most precise, check first
  new RegExp(`[?&](?:q|query|ll|destination|daddr|center)=${NUM}\\s*,\\s*\\+?${NUM}`),
  new RegExp(`@${NUM},${NUM}`), // map view centre
  new RegExp(`^\\s*${NUM}\\s*,\\s*${NUM}\\s*$`), // bare "lat, lng"
];

const coordsIn = (text) => {
  let s = String(text || '');
  try {
    s = decodeURIComponent(s);
  } catch (_) {}
  for (const re of PATTERNS) {
    const m = re.exec(s);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  return null;
};

// A place name carried by the link (…?q=Name, /maps/place/Name/…).
const placeNameIn = (url) => {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('destination');
    if (q && !coordsIn(q)) return q.replace(/\+/g, ' ').trim();
    const m = /\/maps\/place\/([^/]+)/.exec(u.pathname);
    if (m) return decodeURIComponent(m[1]).replace(/\+/g, ' ').trim();
  } catch (_) {}
  return '';
};

const allowedHost = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch (_) {
    return false;
  }
};

// Some ISPs (seen on Jio) answer DNS for maps.app.goo.gl with their own
// server, which never responds — short links then time out. Google's real
// servers are reachable, so these Google hosts are resolved through public
// DNS (Google, then Cloudflare), falling back to the system resolver.
const publicResolver = new dns.Resolver({ timeout: 3000, tries: 1 });
publicResolver.setServers(['8.8.8.8', '1.1.1.1']);
const publicLookup = (hostname, options, callback) => {
  publicResolver.resolve4(hostname, (err, addresses) => {
    if (err || !addresses?.length) return dns.lookup(hostname, options, callback);
    if (options?.all) return callback(null, addresses.map((address) => ({ address, family: 4 })));
    return callback(null, addresses[0], 4);
  });
};

// One request, no redirect following: { status, location }.
const requestOnce = (url) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        lookup: publicLookup,
        headers: { 'User-Agent': 'Mozilla/5.0 (TeamN-ERP map link reader)' },
        timeout: 6000,
      },
      (res) => {
        res.resume(); // the body isn't needed — only the redirect target
        resolve({ status: res.statusCode || 0, location: res.headers.location || '' });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });

// Follow a Google short link hop by hop (never leaving Google hosts).
const expand = async (url) => {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (!allowedHost(current)) return current;
    const { status, location } = await requestOnce(current);
    if (!location || status < 300 || status >= 400) return current;
    current = new URL(location, current).toString();
    if (coordsIn(current)) return current;
  }
  return current;
};

/**
 * @returns {Promise<{ lat, lng } | { query } | null>}
 */
export const locationFromMapLink = async (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;

  const direct = coordsIn(text);
  if (direct) return direct;

  if (!/^https?:\/\//i.test(text)) return null;
  const url = text.replace(/^http:/i, 'https:');
  if (!allowedHost(url)) return null;

  const finalUrl = await expand(url);
  const found = coordsIn(finalUrl);
  if (found) return found;
  const name = placeNameIn(finalUrl);
  return name ? { query: name } : null;
};

// Exposed for tests.
export const _coordsIn = coordsIn;
