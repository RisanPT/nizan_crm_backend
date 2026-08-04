/**
 * timeboxClient.js
 *
 * Thin client for the Timebox attendance / worklist software.
 *
 * Two modes, chosen automatically:
 *   1. LIVE   — when TIMEBOX_API_URL is set in .env, requests are proxied to
 *               the real Timebox REST API with the shared X-Api-Key header and
 *               auto-paginated (following `has_more` / `next_offset`).
 *   2. DEMO   — otherwise the bundled fixtures in fixtures/timebox/*.json are
 *               served and filtered in-memory, so the whole HR + Accounts
 *               integration is fully testable before the live key is wired up.
 *
 * Env vars (LIVE mode):
 *   TIMEBOX_API_URL   = https://timebox.example.com/api        (no trailing slash)
 *   TIMEBOX_API_KEY   = <shared secret>
 *   TIMEBOX_API_HEADER= X-Api-Key                              (optional, default X-Api-Key)
 *
 * The Timebox resources all share the same envelope:
 *   { ok, resource, count, limit, offset, has_more, next_offset,
 *     generated_at, range?, data: [...] }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIMEBOX_URL = (process.env.TIMEBOX_API_URL || '').replace(/\/+$/, '');
const TIMEBOX_KEY = process.env.TIMEBOX_API_KEY || '';
const TIMEBOX_HEADER = process.env.TIMEBOX_API_HEADER || 'X-Api-Key';

/** Safety cap so a runaway `has_more` loop can never hang the request. */
const MAX_PAGES = 50;
const PAGE_SIZE = 500;

export const timeboxMode = () => (TIMEBOX_URL ? 'live' : 'demo');

// ── Fixture (demo) loading ────────────────────────────────────────────────────

const FIXTURES = {
  employees: 'employees.json',
  attendance: 'attendance.json',
  attendance_summary: 'attendance_summary.json',
  timebox: 'timebox.json',
};

const _fixtureCache = {};

function loadFixture(resource) {
  if (_fixtureCache[resource]) return _fixtureCache[resource];
  const file = FIXTURES[resource];
  if (!file) throw new Error(`Unknown Timebox resource: ${resource}`);
  const full = path.resolve(__dirname, '..', 'fixtures', 'timebox', file);
  const raw = fs.readFileSync(full, 'utf-8');
  const parsed = JSON.parse(raw);
  _fixtureCache[resource] = parsed;
  return parsed;
}

/** YYYY-MM-DD (IST) of a record's `date` or ISO timestamp, for range filtering. */
function recordDateOnly(rec) {
  const raw = rec.date || rec.login_time || rec.created_at || '';
  // `date` is already YYYY-MM-DD; timestamps carry +05:30 so slice is safe.
  return String(raw).slice(0, 10);
}

function filterFixture(resource, params = {}) {
  const envelope = loadFixture(resource);
  let rows = Array.isArray(envelope.data) ? [...envelope.data] : [];

  const empId = params.employee_id != null ? Number(params.employee_id) : null;
  if (empId != null && !Number.isNaN(empId)) {
    rows = rows.filter((r) => {
      const id = r.employee?.id ?? r.id;
      return Number(id) === empId;
    });
  }

  const from = params.from ? String(params.from).slice(0, 10) : null;
  const to = params.to ? String(params.to).slice(0, 10) : null;
  if ((from || to) && resource !== 'employees' && resource !== 'attendance_summary') {
    rows = rows.filter((r) => {
      const d = recordDateOnly(r);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  return {
    ok: true,
    resource,
    range: envelope.range,
    generated_at: envelope.generated_at,
    source: 'demo',
    count: rows.length,
    data: rows,
  };
}

// ── Live fetching (auto-paginated) ────────────────────────────────────────────

async function liveFetch(resource, params = {}) {
  // Resource path: attendance_summary → attendance-summary on the wire.
  const resourcePath = resource.replace(/_/g, '-');

  const all = [];
  let offset = Number(params.offset) || 0;
  let range;
  let generatedAt;

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));

    let url;
    if (TIMEBOX_URL.endsWith('.php')) {
      qs.set('resource', resource);
      url = `${TIMEBOX_URL}?${qs.toString()}`;
    } else {
      url = `${TIMEBOX_URL}/${resourcePath}?${qs.toString()}`;
    }

    const headers = {};
    if (TIMEBOX_KEY) {
      if (TIMEBOX_HEADER.toLowerCase() === 'authorization') {
        headers[TIMEBOX_HEADER] = TIMEBOX_KEY.toLowerCase().startsWith('bearer ')
          ? TIMEBOX_KEY
          : `Bearer ${TIMEBOX_KEY}`;
      } else {
        headers[TIMEBOX_HEADER] = TIMEBOX_KEY;
      }
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('Timebox rejected the API key — check TIMEBOX_API_KEY');
    }
    if (!res.ok) {
      throw new Error(`Timebox returned HTTP ${res.status}`);
    }

    const body = await res.json();
    if (body && body.ok === false) {
      throw new Error(body.error || body.message || 'Timebox returned ok:false');
    }

    const rows = Array.isArray(body?.data) ? body.data : [];
    all.push(...rows);
    range = body?.range ?? range;
    generatedAt = body?.generated_at ?? generatedAt;

    if (!body?.has_more) break;
    offset = body?.next_offset ?? offset + rows.length;
    if (rows.length === 0) break;
  }

  let filtered = all;
  const empId = params.employee_id != null ? Number(params.employee_id) : null;
  if (empId != null && !Number.isNaN(empId)) {
    filtered = filtered.filter((r) => {
      const id = r.employee?.id ?? r.id;
      return Number(id) === empId;
    });
  }

  const from = params.from ? String(params.from).slice(0, 10) : null;
  const to = params.to ? String(params.to).slice(0, 10) : null;
  if ((from || to) && resource !== 'employees' && resource !== 'attendance_summary') {
    filtered = filtered.filter((r) => {
      const d = recordDateOnly(r);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
  }

  return {
    ok: true,
    resource,
    range,
    generated_at: generatedAt,
    source: 'live',
    count: filtered.length,
    data: filtered,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a Timebox resource, transparently choosing live vs demo mode and
 * returning the full (de-paginated) row set in a normalised envelope:
 *   { ok, resource, range?, generated_at?, source, count, data:[...] }
 */
export async function timeboxFetch(resource, params = {}) {
  if (!FIXTURES[resource]) {
    throw new Error(`Unknown Timebox resource: ${resource}`);
  }
  if (timeboxMode() === 'live') {
    return liveFetch(resource, params);
  }
  return filterFixture(resource, params);
}
