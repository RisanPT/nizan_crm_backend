// The website's own visitor counter: the public page-view ping and the staff dashboard.
import WebsiteVisit from '../../models/WebsiteVisit.js';
import WebsiteEnquiry from '../../models/WebsiteEnquiry.js';
import { addDays, istStart, todayIst } from '../../utils/istDate.js';
import { clientIp, createRateLimiter } from '../../utils/rateLimiter.js';
import { buildVisitorStats, deviceFromUa, isBot, parseRange, validateVisit } from '../../utils/websiteVisits.js';

// A person browsing quickly makes maybe a page a few seconds; these only stop floods.
const perIp = createRateLimiter({ windowMs: 10 * 60_000, max: 120 });
const overall = createRateLimiter({ windowMs: 60 * 60_000, max: 20_000 });

export const resetVisitLimits = () => {
  perIp.reset();
  overall.reset();
};

// @route POST /api/website/public/visit   (no login)
// body: { vid, sid, path, refHost?, siteHost?, utm?, newVisitor? }
// Always answers 204 — a counter must never show errors to visitors.
export const recordVisit = async (req, res) => {
  try {
    const ua = req.headers['user-agent'];
    if (isBot(ua)) return res.status(204).end();
    if (!perIp.hit(clientIp(req)).allowed || !overall.hit('all').allowed) return res.status(204).end();

    const v = validateVisit(req.body);
    if (!v.ok) return res.status(204).end();

    await WebsiteVisit.create({ ...v.value, day: todayIst(), device: deviceFromUa(ua) });
  } catch (e) {
    console.error('Website visit not saved:', e?.message || e);
  }
  return res.status(204).end();
};

const breakdown = (field, limit) => [
  { $group: { _id: field, views: { $sum: 1 }, ids: { $addToSet: '$vid' } } },
  { $project: { views: 1, visitors: { $size: '$ids' } } },
  { $sort: { visitors: -1, views: -1 } },
  { $limit: limit },
];

// @route GET /api/website/admin/visitors?days=7|30|90
export const getVisitorStats = async (req, res) => {
  try {
    const n = parseRange(req.query.days);
    const today = todayIst();
    const from = addDays(today, -(n - 1));
    const days = Array.from({ length: n }, (_, i) => addDays(from, i));

    const [facetRows, enquiryRows] = await Promise.all([
      WebsiteVisit.aggregate([
        { $match: { day: { $gte: from, $lte: today } } },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  pageViews: { $sum: 1 },
                  vids: { $addToSet: '$vid' },
                  sids: { $addToSet: '$sid' },
                  newVids: { $addToSet: { $cond: ['$newVisitor', '$vid', '$$REMOVE'] } },
                },
              },
              {
                $project: {
                  _id: 0,
                  pageViews: 1,
                  visitors: { $size: '$vids' },
                  visits: { $size: '$sids' },
                  newVisitors: { $size: '$newVids' },
                },
              },
            ],
            today: [
              { $match: { day: today } },
              { $group: { _id: null, pageViews: { $sum: 1 }, ids: { $addToSet: '$vid' } } },
              { $project: { _id: 0, pageViews: 1, visitors: { $size: '$ids' } } },
            ],
            daily: [
              { $group: { _id: '$day', pageViews: { $sum: 1 }, ids: { $addToSet: '$vid' } } },
              { $project: { pageViews: 1, visitors: { $size: '$ids' } } },
            ],
            pages: breakdown('$path', 10),
            sources: breakdown('$source', 10),
            devices: breakdown('$device', 3),
          },
        },
      ]),
      WebsiteEnquiry.aggregate([
        { $match: { createdAt: { $gte: istStart(from) }, status: { $ne: 'spam' } } },
        { $group: { _id: '$type', n: { $sum: 1 } } },
      ]),
    ]);

    const enquiries = Object.fromEntries((enquiryRows || []).map((r) => [r._id, r.n]));
    res.json(buildVisitorStats({ facet: facetRows?.[0] || {}, days, today, enquiries }));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

