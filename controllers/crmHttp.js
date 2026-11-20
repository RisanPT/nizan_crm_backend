import mongoose from 'mongoose';
import { crmViewerOf } from '../utils/crmAccess.js';

// What every /api/crm handler shares: a refusal with its status (`fail`), a wrapper that turns it into the response (`route`), the guard
// that lets only the CRM team, management and leadership in (`crmGuard`, sets req.crmViewer), and "may this login change things".

export class CrmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/// Stops the handler with [status] and [message].
export const fail = (status, message) => {
  throw new CrmError(status, message);
};

/// Wraps a handler: a CrmError becomes its status and message, a bad id / invalid record a 400, anything else a 500.
export const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof CrmError) return res.status(e.status).json({ message: e.message });
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return res.status(400).json({ message: e.message });
    console.error('crm:', e);
    res.status(500).json({ message: e.message || 'Something went wrong.' });
  }
};

/// Route guard: only the CRM team, its head, management and leadership. Sets req.crmViewer.
export const crmGuard = (req, res, next) => {
  const viewer = crmViewerOf(req.user);
  if (viewer === 'none') return res.status(403).json({ message: 'This is for the CRM team.' });
  req.crmViewer = viewer;
  next();
};

export const mayWrite = (viewer) => viewer === 'admin' || viewer === 'head' || viewer === 'member';
export const requireWriter = (req) => {
  if (!mayWrite(req.crmViewer)) fail(403, 'This login can only look.');
};

export const lc = (v) => String(v ?? '').trim().toLowerCase();
export const idOf = (v) => (v == null ? '' : String(v._id ?? v));
export const isId = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;
export const oid = (v) => new mongoose.Types.ObjectId(String(v));
