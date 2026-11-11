import AuditLog from '../models/AuditLog.js';

// Best-effort HR / payroll change log. logChange() NEVER throws and never
// blocks the caller's response: on any failure it console.warns and returns.

const MASKED_FIELDS = new Set([
  'accountNumber',
  'bankDetails.accountNumber',
  'panNumber',
]);

/// Last 4 characters only ("••••1234"); empty stays empty.
export const maskTail = (value) => {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s.length <= 4 ? `••••${s}` : `••••${s.slice(-4)}`;
};

/// Reads `a.b.c` from a doc or plain object.
const getPath = (obj, path) => {
  if (!obj) return undefined;
  if (typeof obj.get === 'function' && typeof obj.toObject === 'function') {
    const v = obj.get(path);
    if (v !== undefined) return v;
  }
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
};

/// Plain, comparable, storable value.
const normalize = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object') {
    if (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID') return String(v);
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  }
  return v;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// Takes a snapshot of `fields` from a doc (call BEFORE mutating it).
export const snapshot = (doc, fields) => {
  const out = {};
  for (const f of fields) out[f] = normalize(getPath(doc, f));
  return out;
};

/// Diff of `fields` between two docs / snapshots; masks sensitive values.
export const diffFields = (before, after, fields) => {
  const changes = [];
  for (const field of fields) {
    const from = normalize(getPath(before, field) ?? (before ? before[field] : undefined));
    const to = normalize(getPath(after, field) ?? (after ? after[field] : undefined));
    if (same(from, to)) continue;
    if (MASKED_FIELDS.has(field)) {
      changes.push({ field, from: from == null ? null : maskTail(from), to: to == null ? null : maskTail(to) });
    } else {
      changes.push({ field, from, to });
    }
  }
  return changes;
};

/**
 * Record a change. `before` / `after` may be docs, plain objects or snapshots.
 * With `fields`, only changed fields are written, and nothing is written when
 * none changed (unless `always` is true, e.g. for approve / delete / lock).
 * Pass `by` / `byName` when there is no `req` (e.g. approval engine).
 */
export const logChange = async ({
  req = null,
  entity,
  entityId = null,
  employeeId = null,
  action,
  before = null,
  after = null,
  fields = [],
  note = '',
  always = false,
  by = null,
  byName = '',
} = {}) => {
  try {
    const changes = fields.length ? diffFields(before, after, fields) : [];
    if (!changes.length && !always) return null;
    const user = req?.user || null;
    return await AuditLog.create({
      entity,
      entityId: entityId || null,
      employeeId: employeeId || null,
      action: String(action || 'update'),
      changes,
      by: by || user?._id || null,
      byName: byName || user?.name || '',
      at: new Date(),
      note: String(note || ''),
    });
  } catch (err) {
    console.warn('[audit] logChange failed:', err?.message || err);
    return null;
  }
};
