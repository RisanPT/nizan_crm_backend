import express from "express";
import {
  getDriverJobs,
  startTripWithInspection,
  startNextTrip,
  completeJob,
  reportAccident,
  submitDriverReview,
  getDriverReviews,
  getAccidentReports,
  getCompletedWorks,
  getKmReport,
  getServiceReminders,
  addServiceReminder,
  completeServiceReminder
} from "../controllers/fleetController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Guard: allow fleet_manager or admin
const fleetManagerOrAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'fleet_manager')) {
    return next();
  }
  return res.status(403).json({ message: 'Not authorized as fleet manager or admin' });
};

// ── Driver routes ───────────────────────────────────────────────
router.get("/driver/jobs", protect, getDriverJobs);
router.post("/driver/inspection/:jobId", protect, startTripWithInspection);
router.post("/driver/start-next/:jobId", protect, startNextTrip);
router.post("/driver/complete/:jobId", protect, completeJob);
router.post("/driver/accident", protect, reportAccident);

// ── Artist route ────────────────────────────────────────────────
router.post("/review", protect, submitDriverReview);

// ── Fleet Manager / Admin routes ────────────────────────────────
router.get("/manager/reviews", protect, fleetManagerOrAdmin, getDriverReviews);
router.get("/manager/accidents", protect, fleetManagerOrAdmin, getAccidentReports);
router.get("/manager/completed-works", protect, fleetManagerOrAdmin, getCompletedWorks);
router.get("/manager/km-report", protect, fleetManagerOrAdmin, getKmReport);
router.get("/manager/service-reminders", protect, fleetManagerOrAdmin, getServiceReminders);
router.post("/manager/service-reminders", protect, fleetManagerOrAdmin, addServiceReminder);
router.post("/manager/service-reminders/:id/complete", protect, fleetManagerOrAdmin, completeServiceReminder);

export default router;
