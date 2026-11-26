// CONNECT THE CRM TO DROPBOX — gets the long-lived refresh token and saves it in backend/.env, so nothing has to be typed into a curl
// command. Run it from the backend folder, in a normal Terminal window:
//
//   node scripts/dropboxConnect.mjs
//
// It reads DROPBOX_APP_KEY and DROPBOX_APP_SECRET from .env (or asks for them), opens Dropbox's "Allow" page, takes the access code you
// paste, swaps it for the refresh token and writes DROPBOX_REFRESH_TOKEN into .env (a copy of the old .env is kept as .env.bak-dropbox).
// The token is never printed. It then checks the permissions the app was given and, if you paste one, that a folder link can be read.
// For the live server, copy the three DROPBOX_ lines into the server's .env and restart the backend.
//
// DROPBOX_CONNECT_ENV / DROPBOX_TOKEN_URL / DROPBOX_API_URL point elsewhere for a test only.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const envPath = process.env.DROPBOX_CONNECT_ENV || fileURLToPath(new URL('../.env', import.meta.url));
const tokenUrl = process.env.DROPBOX_TOKEN_URL || 'https://api.dropbox.com/oauth2/token';
const apiUrl = process.env.DROPBOX_API_URL || 'https://api.dropboxapi.com';
// files.content.read: the gallery plays the company's own Dropbox videos straight from Dropbox (a 4-hour link), not through the server
const NEEDED = ['files.metadata.read', 'files.content.read', 'files.content.write', 'file_requests.write', 'sharing.read', 'sharing.write'];

const readEnv = () => {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return { text, values: out };
};

/** .env with [values] set (each line replaced where it is, or added at the end); the rest kept as it was. */
const writeEnv = (text, values) => {
  const lines = text ? text.split(/\r?\n/) : [];
  const left = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && left.has(m[1])) {
      const v = left.get(m[1]);
      left.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (next.length && next[next.length - 1] === '') next.pop();
  for (const [k, v] of left) next.push(`${k}=${v}`);
  if (fs.existsSync(envPath)) fs.copyFileSync(envPath, `${envPath}.bak-dropbox`);
  fs.writeFileSync(envPath, `${next.join('\n')}\n`, { mode: 0o600 });
};

// answers are read line by line as they come (typed, or pasted several at once) and handed to each question in turn
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
let muted = false; // a secret being typed: nothing is echoed
const write = rl._writeToOutput?.bind(rl);
if (write) rl._writeToOutput = (s) => { if (!muted) write(s); };
const lines = [];
const waiting = [];
let ended = false;
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => {
  ended = true;
  while (waiting.length) waiting.shift()(null);
});
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((r) => waiting.push(r)));
const ask = async (q, { hidden = false } = {}) => {
  if (hidden || ended) {
    stdout.write(q);
    if (!ended) rl.setPrompt('');
    muted = hidden;
  } else {
    rl.setPrompt(q);
    rl.prompt();
  }
  const a = await nextLine();
  muted = false;
  if (hidden || !stdin.isTTY) stdout.write('\n');
  return String(a ?? '').trim();
};
const askHidden = (q) => ask(q, { hidden: true });
const stop = (msg) => {
  console.log(`\n✖ ${msg}\n`);
  rl.close();
  process.exit(1);
};

console.log('\nConnect the CRM to Dropbox\n──────────────────────────');
const { text, values } = readEnv();
let key = values.DROPBOX_APP_KEY ?? '';
let secret = values.DROPBOX_APP_SECRET ?? '';
const tail = (k) => `…${k.slice(-4)}`;

/** Does the Dropbox app saved in .env still work? → '' when it does, else Dropbox's reason ("app is disabled" for a deleted app). */
const savedProblem = async () => {
  if (!values.DROPBOX_REFRESH_TOKEN) return '';
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: values.DROPBOX_REFRESH_TOKEN, client_id: key, client_secret: secret }).toString(),
    });
    const b = await res.json().catch(() => ({}));
    return b.access_token ? '' : [b.error, b.error_description].filter((x) => x && typeof x === 'string').join(' — ') || `HTTP ${res.status}`;
  } catch {
    return ''; // offline: no verdict — the steps below say so
  }
};

if (key && secret) {
  // A NEW Dropbox app (the old one deleted or replaced): its key goes in here — the saved one is never reused without asking.
  const problem = await savedProblem();
  if (/disabled|invalid_client/i.test(problem)) {
    // the app itself is gone (deleted / disabled) or its key and secret don't match
    console.log(`✖ The Dropbox app saved in ${envPath} (App key ${tail(key)}) no longer works — Dropbox says: ${problem}.`);
    console.log('  Use your NEW app: Dropbox App Console → the new app → Settings → App key / App secret.');
    key = '';
    secret = '';
  } else {
    // the app is fine (its key and secret may just have been put into .env by hand) — only its connection needs making again
    if (problem) console.log(`The saved connection no longer works (Dropbox says: ${problem}) — connect it again below.`);
    console.log(`Saved in ${envPath}: the app with App key ${tail(key)}.`);
    const ans = await ask('Press Enter to connect with that app — or, for a NEW Dropbox app, paste its App key here: ');
    if (ans && !/^(y|yes)$/i.test(ans)) {
      key = /^(n|no|new)$/i.test(ans) ? '' : ans;
      secret = '';
    }
  }
}
if (!key) key = await ask('Paste the App key (Dropbox App Console → your app → Settings): ');
if (!secret) secret = await askHidden('Paste the App secret (it stays hidden while you paste): ');
if (!key || !secret) stop('The App key and App secret are both needed.');

// Ask for exactly the permissions the CRM uses (plus account_info.read, always on): a Team permission left ticked in the App Console
// then cannot turn this into a "work account only" link.
const scope = ['account_info.read', ...NEEDED].join(' ');
const authorize = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(key)}&response_type=code&token_access_type=offline&scope=${encodeURIComponent(scope)}`;
console.log('\nStep 1 — the COMPANY Dropbox account (the one the footage should go to) allows the CRM:');
console.log(`  ${authorize}`);
console.log('  • If you use that account yourself: Dropbox opens in your browser — sign in, click Continue → Allow, copy the code.');
console.log('  • If someone else looks after it (e.g. the Marketing team): send them the link above. They open it, sign in to THEIR');
console.log('    Dropbox, click Continue → Allow, and send you the code straight away (it works for a few minutes only).');
console.log('    This window waits for you — paste the code as soon as it arrives.');
console.log('  • "Please sign in with a work account"? The app still has TEAM permissions: App Console → the app → Permissions →');
console.log('    untick everything under "Team scopes", click Submit, then open the link again.');
console.log('  • "Error connecting app" / scope? Tick the missing permission under "Individual scopes", Submit, open the link again.');
if (process.platform === 'darwin' && stdout.isTTY) execFile('open', [authorize], () => {});
const code = await ask('\nStep 2 — paste the code here and press Enter: ');
if (!code) stop('No code was pasted. Run the script again.');

let body = {};
try {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, grant_type: 'authorization_code' }).toString(),
  });
  body = await res.json().catch(() => ({}));
} catch {
  stop('Dropbox could not be reached. Check the internet connection and run the script again.');
}
if (!body.refresh_token) {
  const why = [body.error, body.error_description].filter(Boolean).join(' — ') || 'no answer';
  if (/disabled/i.test(why)) stop(`Dropbox says this app is disabled (${why}) — it is an old or deleted app.\n  Run this again and paste the App key and App secret of your NEW app (App Console → the app → Settings).`);
  if (/invalid_client|client_id|client_secret/i.test(why)) stop(`Dropbox says the App key or App secret is wrong (${why}).\n  Copy both again from the app's Settings tab into backend/.env — no spaces or quotes — and run this again.`);
  if (/invalid_grant|code/i.test(why)) stop(`Dropbox did not take the code (${why}).\n  A code works once and only for a few minutes — run the script again and paste the new code straight away.`);
  stop(`Dropbox said: ${why}`);
}

writeEnv(text, { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: body.refresh_token });
console.log(`\n✔ Connected. The refresh token is saved in ${envPath} as DROPBOX_REFRESH_TOKEN (it is not shown here).`);
if (fs.existsSync(`${envPath}.bak-dropbox`)) console.log(`  Your previous .env is kept as ${envPath}.bak-dropbox`);

// whose Dropbox it is — so a click on Allow from the wrong account shows at once
try {
  const res = await fetch(`${apiUrl}/2/users/get_current_account`, { method: 'POST', headers: { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' }, body: 'null' });
  const me = await res.json().catch(() => ({}));
  if (res.ok && me.name) {
    console.log(`  Connected to the Dropbox of: ${me.name.display_name ?? ''}${me.email ? ` (${me.email})` : ''}`);
    console.log('  If that is not the company / Marketing Dropbox, run this again and have the right account click Allow.');
  }
} catch {
  // not shown — the connection itself is fine
}

const granted = String(body.scope ?? '').split(/\s+/).filter(Boolean);
const missing = granted.length ? NEEDED.filter((s) => !granted.includes(s)) : [];
if (missing.length) {
  console.log('\n✖ NOT READY YET — the Dropbox app is missing permissions:');
  console.log(`    ${missing.join(', ')}`);
  console.log('  Dropbox App Console → the app → Permissions: tick them, click Submit. Then run this script again and click Allow');
  console.log('  again — the token only has the permissions the app had at the moment of Allow.');
}

const link = await ask('\nStep 3 (optional) — paste an artist\'s Dropbox folder link to test it, or just press Enter to skip: ');
if (link) {
  try {
    const res = await fetch(`${apiUrl}/2/files/list_folder`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '', shared_link: { url: link.replace(/([?&])dl=\d/, '$1').replace(/[?&]$/, '') } }),
    });
    const r = await res.json().catch(() => ({}));
    if (res.ok) {
      const entries = r.entries ?? [];
      const files = entries.filter((e) => e['.tag'] === 'file').length;
      const folders = entries.filter((e) => e['.tag'] === 'folder').length;
      console.log(`✔ The CRM can read that folder: ${files} file(s)${folders ? ` and ${folders} folder(s)` : ''}${r.has_more ? ' (and more)' : ''}.`);
    } else if (/access_denied/.test(r.error_summary ?? '')) {
      console.log('✖ Dropbox says that folder is not shared with "anyone with the link". In Dropbox: Share → "Anyone with this link can view" → Copy link.');
    } else {
      console.log(`✖ Dropbox could not read that folder (${r.error_summary || `HTTP ${res.status}`}).`);
    }
  } catch {
    console.log('✖ Dropbox could not be reached for the test.');
  }
}

console.log('\nNext:');
console.log('  • Here (local): restart the backend so it reads the new .env.');
console.log('  • Live server: copy the three lines DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN from this .env');
console.log('    into /home/ubuntu/Nizan_ERP_CRM/backend/.env on the server, then run:  pm2 restart nizan-backend\n');
rl.close();
