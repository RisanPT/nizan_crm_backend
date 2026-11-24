import asyncHandler from 'express-async-handler';
import { qualityReport, artistWorks } from '../services/workQuality.js';
import { SCORE_AREAS } from '../utils/workReview.js';
import { isDay, todayIst, addDays } from '../utils/istDate.js';
import { assetShape } from './marketingSocialsController.js';

// Creative Portfolio → Artist Quality: what the clients said about each artist's work (the review the CRM sends the morning after a
// work, matched by its booking), so the team sees whose work needs a look and in what — and the work's own photos and videos beside it.
// Every artist on a work gets its rating. Marketing roles (the Creative Portfolio's gate, routes/marketingPortfolioRoutes.js).

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

/** ?from=&to= — the works' event days; the last 90 days when not given. */
const period = (req, res) => {
  const to = req.query.to ?? todayIst();
  const from = req.query.from ?? addDays(to, -89);
  if (!isDay(from) || !isDay(to)) bad(res, 'Pick the days as YYYY-MM-DD.');
  if (from > to) bad(res, 'The start day is after the end day.');
  if (addDays(from, 731) <= to) bad(res, 'Pick at most two years at a time.');
  return { from, to };
};

/** GET /api/marketing/portfolio/quality — every artist, the ones needing a look first, and the figures over all works. */
export const getQuality = asyncHandler(async (req, res) => {
  const { from, to } = period(req, res);
  const report = await qualityReport(from, to);
  res.json({ ...report, areas: SCORE_AREAS.map(({ key, label }) => ({ key, label })) });
});

/** GET /api/marketing/portfolio/quality/artist/:key — one artist's works (worst first), each with its gallery photos and videos. */
export const getArtistQuality = asyncHandler(async (req, res) => {
  const { from, to } = period(req, res);
  const key = String(req.params.key ?? '').trim();
  if (!key) bad(res, 'Which artist?');
  const { artist, works } = await artistWorks(key, from, to);
  if (!artist) bad(res, 'This artist has no reviewed work in these days.', 404);
  res.json({
    from,
    to,
    artist,
    works: works.map(({ items, ...w }) => ({ ...w, items: items.map((a) => assetShape(a)) })),
  });
});
