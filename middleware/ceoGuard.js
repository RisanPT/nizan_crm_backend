import { isCeo, ceoVerdict, redactPay } from '../utils/ceoAccess.js';

/// Called by `protect` once the user is loaded. For the CEO login: refuses writes (except the decisions it may take) and the
/// pay / bank routes, and strips pay fields from the people list. Returns true when it has answered the request itself.
export const applyCeoGuard = (req, res) => {
  if (!isCeo(req.user)) return false;

  const verdict = ceoVerdict(req.method, req.originalUrl);
  if (!verdict.ok) {
    res.status(verdict.status).json({ message: verdict.message, code: verdict.code });
    return true;
  }

  if (verdict.redact) {
    const send = res.json.bind(res);
    res.json = (body) => send(redactPay(body));
  }
  return false;
};
