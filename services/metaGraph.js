// Calling Meta's Graph API — shared by Lead Ads (services/metaLeads.js) and the ad spend sync (services/metaAdsSync.js).
// Every call carries the token and its appsecret_proof (so a stolen token alone is no use elsewhere); a failure becomes a MetaProblem with
// a reason the Marketing team can read (utils/metaLeads.js META_PROBLEMS). Graph's own next-page links are followed only on Graph's host.
// Nothing here returns or logs the token.
import { appSecretProof, classifyGraphError, isGraphUrl, problem } from '../utils/metaLeads.js';

const GRAPH = 'https://graph.facebook.com';
const CALL_TIMEOUT_MS = 15_000;

// The network, swappable in tests (no request leaves the machine there).
let metaFetch = (url, opts) => fetch(url, opts);
export const _setMetaFetch = (fn) => {
  metaFetch = fn ?? ((url, opts) => fetch(url, opts));
};

/** A Graph call that failed for a reason the team can read. */
export class MetaProblem extends Error {
  constructor(p) {
    super(p.text);
    this.problem = p;
  }
}

/** GET a Graph path (or one of Graph's own next-page links) with [token] + its appsecret_proof → the JSON body, or a MetaProblem. */
export const graphGet = async (cfg, pathOrUrl, params, token, { timeoutMs = CALL_TIMEOUT_MS } = {}) => {
  let url;
  if (pathOrUrl.startsWith('https://')) {
    if (!isGraphUrl(pathOrUrl)) throw new MetaProblem(problem('refused', 'a next-page link that is not on graph.facebook.com'));
    url = new URL(pathOrUrl);
  } else {
    url = new URL(`${GRAPH}/${cfg.version}/${pathOrUrl}`);
  }
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  url.searchParams.set('access_token', token);
  url.searchParams.set('appsecret_proof', appSecretProof(token, cfg.appSecret));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await metaFetch(url.toString(), { method: 'GET', headers: { accept: 'application/json' }, signal: ctl.signal });
    } catch {
      throw new MetaProblem(problem('unreachable'));
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || body?.error) throw new MetaProblem(classifyGraphError(res.status, body));
    return body ?? {};
  } finally {
    clearTimeout(timer);
  }
};

/** Every row of a Graph list with one token, following Graph's next-page links (only on Graph's host) up to [maxPages]. */
export const graphList = async (cfg, path, params, token, { maxPages = 50, timeoutMs } = {}) => {
  const out = [];
  let body = await graphGet(cfg, path, params, token, { timeoutMs });
  for (let i = 1; ; i += 1) {
    if (Array.isArray(body.data)) out.push(...body.data);
    const next = body.paging?.next;
    if (!next || !isGraphUrl(next)) return out;
    if (i >= maxPages) throw new MetaProblem(problem('refused', `more than ${maxPages} pages of results: choose fewer days`));
    body = await graphGet(cfg, next, {}, token, { timeoutMs });
  }
};

/**
 * POST a JSON body (already serialised) to a Graph path → the JSON answer, or a MetaProblem. [proof]: add our app's appsecret_proof —
 * false for a token Events Manager made (it belongs to Meta's own app, so our proof would not match it).
 */
export const graphPost = async (cfg, path, jsonBody, token, { proof = true, timeoutMs = 30_000 } = {}) => {
  const url = new URL(`${GRAPH}/${cfg.version}/${path}`);
  url.searchParams.set('access_token', token);
  if (proof) url.searchParams.set('appsecret_proof', appSecretProof(token, cfg.appSecret));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await metaFetch(url.toString(), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: jsonBody, signal: ctl.signal });
    } catch {
      throw new MetaProblem(problem('unreachable'));
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || body?.error) throw new MetaProblem(classifyGraphError(res.status, body));
    return body ?? {};
  } finally {
    clearTimeout(timer);
  }
};
