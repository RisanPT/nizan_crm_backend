import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { distanceFromHq, distanceFromMapLink, DistanceError } from '../utils/distance.js';

const router = express.Router();

router.use(protect);

// @route GET /api/geo/distance?pincode=673014  (or ?address=…, or ?link=<map link / "lat, lng">)
// Road distance + drive time from the headquarters (utils/distance.js).
router.get('/distance', async (req, res) => {
  try {
    const result = String(req.query.link || '').trim()
      ? await distanceFromMapLink(String(req.query.link))
      : await distanceFromHq({
          pincode: req.query.pincode,
          address: req.query.address,
        });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof DistanceError ? err.status : 500;
    if (!(err instanceof DistanceError)) console.error('distance failed:', err);
    res.status(status).json({
      ok: false,
      error: err instanceof DistanceError ? err.message : 'Could not calculate the distance right now.',
    });
  }
});

export default router;
