// Express 4 does not catch errors thrown from `async` route handlers: the
// promise rejects, no response is ever sent, and the client waits until it
// times out (and Node logs an unhandled rejection). Express 5 fixed this; this
// patch backports that behaviour so every rejected handler is forwarded to
// `next(err)` and reaches the global error handler in middleware/errorMiddleware.js.
//
// Import this once, before routes handle any request.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    // Error-handling middleware (4 args) is skipped for normal requests —
    // same as Express's own implementation.
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (ret && typeof ret.catch === 'function') {
        ret.catch((err) => next(err ?? new Error('Request handler failed')));
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncPatched = true;
}
