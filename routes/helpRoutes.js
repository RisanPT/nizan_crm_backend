import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { answer, loadManual } from '../services/helpBot.js';

const router = express.Router();
router.use(protect);

// Per-user limit so a stuck client cannot run up Gemini cost.
const hits = new Map();
const LIMIT = 40;
const WINDOW_MS = 60 * 60 * 1000;
function limited(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  return recent.length > LIMIT;
}

// Which route gates each manual entry. The app applies its own permission
// rules to these and sends back the ids the user may use.
router.get('/index', (_req, res) => {
  res.json(loadManual().map((e) => ({ id: e.id, gate: e.gate || e.route || null })));
});

router.post('/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim().slice(0, 400);
  if (!question) return res.status(400).json({ message: 'Please type a question.' });
  if (limited(String(req.user?._id ?? req.user?.id ?? 'anon'))) {
    return res.status(429).json({ message: 'Too many questions this hour. Please try again later.' });
  }
  const allowedIds = Array.isArray(req.body?.allowedIds) ? req.body.allowedIds.map(String).slice(0, 500) : [];
  const history = Array.isArray(req.body?.history)
    ? req.body.history.filter((h) => h && typeof h.text === 'string').slice(-6)
    : [];
  try {
    res.json(await answer({ question, allowedIds, history }));
  } catch (e) {
    console.error('[help] ask failed:', e.message);
    res.status(500).json({ message: 'The help assistant is unavailable right now.' });
  }
});

export default router;
