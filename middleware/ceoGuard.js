import { isCeo, ceoVerdict, redactPay, scrubPayText } from '../utils/ceoAccess.js';

/// Called by `protect` once the user is loaded. For a leadership login (CEO or Executive Director): refuses writes (except the
/// decisions it may take) and the pay / bank routes, strips pay fields from the people list and pay narrations from the accounts.
/// Returns true when it has answered the request itself.
export const applyCeoGuard = (req, res) => {
  if (!isCeo(req.user)) return false;

  const verdict = ceoVerdict(req.method, req.originalUrl);
  if (!verdict.ok) {
    res.status(verdict.status).json({ message: verdict.message, code: verdict.code });
    return true;
  }

  if (verdict.redact || verdict.scrub) {
    const send = res.json.bind(res);
    res.json = (body) => send(verdict.scrub ? scrubPayText(verdict.redact ? redactPay(body) : body) : redactPay(body));
  }
  return false;
};
