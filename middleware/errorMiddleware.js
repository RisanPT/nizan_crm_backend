// App-wide error handling so every failure reaches the client as a short,
// readable JSON `{ message }` with a meaningful status code:
//
//  • sanitizeErrorResponses — many controllers do
//      res.status(500).json({ message: error.message })
//    which leaks raw MongoDB/JS text ("Cast to ObjectId failed…", "E11000
//    duplicate key…", "Cannot read properties of undefined…"). This rewrites
//    such messages into human ones (and fixes the status: bad id → 400,
//    duplicate → 409, validation → 400) and logs the original for debugging.
//  • notFound      — unknown /api routes get JSON 404 instead of an HTML page.
//  • errorHandler  — the final catch-all for thrown/forwarded errors
//    (malformed JSON bodies, CORS rejections, upload limits, anything else).

const GENERIC_500 = 'Something went wrong on the server. Please try again.';
const DB_DOWN = 'The database is temporarily unavailable. Please try again shortly.';

const humanField = (f) =>
  String(f || '')
    .replace(/\.\d+\./g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .trim()
    .toLowerCase();

const TECHNICAL = [
  /Cannot read propert/i,
  /is not a function/i,
  /is not defined/i,
  /undefined|null/,
  /Mongo(Server|Network)?Error/i,
  /ECONN(REFUSED|RESET)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/,
  /topology|server selection/i,
  /Unexpected token/i,
  /at .+\(.+:\d+:\d+\)/, // stack frame
];

/**
 * Map a raw error message to { status, message } or null to leave it alone.
 * Exported for tests.
 */
export const classifyErrorMessage = (raw, status) => {
  const msg = String(raw ?? '');
  if (!msg) return null;

  // Invalid ObjectId / wrong type in a query or body.
  if (/Cast to ObjectId failed/i.test(msg)) {
    return { status: 400, message: 'Invalid ID — this record may not exist or the link is broken.' };
  }
  const cast = msg.match(/Cast to (\w+) failed .*? at path "([^"]+)"/i);
  if (cast) {
    return { status: 400, message: `Invalid value for ${humanField(cast[2])}.` };
  }

  // Unique index violation.
  if (/E11000 duplicate key/i.test(msg)) {
    const key = msg.match(/dup key: \{\s*"?([\w.]+)"?\s*:/);
    const field = key ? humanField(key[1]) : '';
    return {
      status: 409,
      message: field
        ? `A record with this ${field} already exists.`
        : 'This record already exists.',
    };
  }

  // Mongoose validation: "Lead validation failed: phone: Path `phone` is required., …"
  if (/validation failed:/i.test(msg)) {
    const parts = msg
      .replace(/^.*?validation failed:\s*/i, '')
      .split(/,\s*(?=[\w.]+: )/)
      .map((p) => p.replace(/^[\w.]+:\s*/, '').trim())
      .map((p) =>
        p
          .replace(/Path `([^`]+)` is required\.?/i, (_, f) => `${humanField(f)} is required`)
          .replace(/Path `([^`]+)` \((.*?)\) is (less|more) than minimum allowed value \((.*?)\)\.?/i,
            (_, f, _v, lm, lim) => `${humanField(f)} must be ${lm === 'less' ? 'at least' : 'at most'} ${lim}`)
          .replace(/`([^`]+)` is not a valid enum value for path `([^`]+)`\.?/i,
            (_, v, f) => `"${v}" is not a valid ${humanField(f)}`)
          .replace(/Path `([^`]+)`/g, (_, f) => humanField(f))
          .replace(/\.$/, '')
      )
      .filter(Boolean);
    const text = parts.join('; ');
    return { status: 400, message: text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : 'Some of the information provided is not valid.' };
  }

  // Database connectivity problems.
  if (/buffering timed out|MongoNetworkError|MongoServerSelectionError|ECONNREFUSED.*27017|topology was destroyed/i.test(msg)) {
    return { status: 503, message: DB_DOWN };
  }

  // Any other server error that reads like code rather than a sentence.
  if (status >= 500 && (msg.length > 200 || TECHNICAL.some((re) => re.test(msg)))) {
    return { status, message: GENERIC_500 };
  }
  return null;
};

export const sanitizeErrorResponses = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const out = { ...body };
      if (typeof out.message === 'string') {
        const mapped = classifyErrorMessage(out.message, res.statusCode);
        if (mapped) {
          console.error(`[${req.method} ${req.originalUrl}] ${res.statusCode}: ${out.message}`);
          res.status(mapped.status);
          out.message = mapped.message;
        }
      } else if (out.message == null && typeof out.error === 'string') {
        // Normalise `{ error: '...' }` bodies to `{ message }` too.
        const mapped = classifyErrorMessage(out.error, res.statusCode);
        out.message = mapped ? mapped.message : out.error;
        if (mapped) res.status(mapped.status);
      }
      // Never ship stack traces to the client.
      delete out.stack;
      return json(out);
    }
    return json(body);
  };
  next();
};

// The user-facing message stays plain; the exact route is in `path` (and the
// server log) for debugging. A 404 here usually means the app is newer than
// the server that's running.
export const notFound = (req, res) => {
  console.warn(`404 API route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    message: "This feature isn't available on the server yet. The server may need to be updated.",
    path: `${req.method} ${req.originalUrl}`,
  });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = Number(err?.status || err?.statusCode) || 0;
  let message = err?.message || GENERIC_500;

  if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'The request data is malformed (invalid JSON).';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'The request is too large.';
  } else if (/^CORS blocked/.test(message)) {
    status = 403;
    message = 'This site is not allowed to access the server.';
  } else if (err?.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large to upload.' : `Upload failed: ${message}`;
  } else if (err?.name === 'CastError' || err?.name === 'ValidationError' || err?.code === 11000) {
    status = status || 400; // refined by classifyErrorMessage below
  } else if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    status = 401;
    message = 'Your session has expired. Please log in again.';
  }

  if (!status || status < 400) status = 500;
  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}] Unhandled error:`, err);
  }
  // res.json is wrapped by sanitizeErrorResponses, which humanises `message`.
  res.status(status).json({ message });
};
