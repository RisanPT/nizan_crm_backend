import Booking from "../models/Booking.js";
import AccidentReport from "../models/AccidentReport.js";
import DriverReview from "../models/DriverReview.js";
import ServiceReminder from "../models/ServiceReminder.js";
import mongoose from "mongoose";
import Vehicle from "../models/Vehicle.js";
import FuelExpense from "../models/FuelExpense.js";
import { notifyRoles } from "../utils/notify.js";

// Roles that oversee the fleet.
const FLEET_MANAGER_ROLES = ["fleet_manager", "admin", "manager"];

// Odometer reading from the request: a finite, non-negative km value (one
// decimal kept), or null when missing / not a number.
const parseKm = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 9999999) return null;
  return Math.round(n * 10) / 10;
};

const driverIdOf = (user) =>
  user.employeeId ? user.employeeId.toString() : user._id.toString();

// Trips that haven't started yet.
const NOT_STARTED = ["unassigned", "assigned", "inspection_pending"];

// Start/end of the studio (IST) calendar day containing `date`.
const IST_MS = 330 * 60000;
const istDayBounds = (date) => {
  const key = new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);
  const start = new Date(`${key}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 86400000) };
};

// The driver's trip that is currently running, other than `exceptId`.
const activeTripOf = (driverId, exceptId = null) =>
  Booking.findOne({
    driverId,
    tripStatus: "in_progress",
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select("customerName bookingNumber");

// Marks a not-yet-started trip as started, without inspection photos (the
// day's inspection was done on the first trip). Returns the updated job, or
// null when it had already been started.
const startChainedTrip = (jobId, startKm) =>
  Booking.findOneAndUpdate(
    { _id: jobId, tripStatus: { $in: NOT_STARTED } },
    {
      $set: {
        tripStatus: "in_progress",
        startKm,
        endKm: null,
        tripStartedAt: new Date(),
        tripCompletedAt: null,
      },
    },
    { new: true }
  );

// The driver's not-started trips on the same studio day as `date`, earliest
// first.
const pendingTripsSameDay = (driverId, date, exceptId) => {
  const { start, end } = istDayBounds(date);
  return Booking.find({
    driverId,
    tripStatus: { $in: NOT_STARTED },
    serviceStart: { $gte: start, $lt: end },
    _id: { $ne: exceptId },
  })
    .select("bookingNumber customerName address mapUrl service eventSlot serviceStart serviceEnd vehicleId tripStatus driverId pocName pocPhone")
    .populate("vehicleId", "registrationNumber type")
    .sort({ serviceStart: 1 });
};

// @desc    Get jobs assigned to logged-in driver
// @route   GET /api/fleet/driver/jobs
// @access  Private (Driver)
export const getDriverJobs = async (req, res) => {
  try {
    const driverId = req.user.employeeId || req.user._id; // Use employeeId if available
    // Find bookings assigned to this driver, sorted by date
    const jobs = await Booking.find({ driverId: driverId })
      .select(
        'bookingNumber driverId vehicleId preTripPhotos tripStatus customerName ' +
        'address mapUrl service eventSlot serviceStart serviceEnd ' +
        'travelDistanceKm pocName pocPhone assignedStaff bookingItems ' +
        'startKm endKm tripStartedAt tripCompletedAt'
      )
      // currentKm lets the app show the vehicle's last recorded reading as a
      // hint when the driver enters the starting km.
      .populate('vehicleId', 'registrationNumber type currentKm')
      .sort({ serviceStart: 1 });

    res.json(jobs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Upload pre-trip photos + starting km and start trip
// @route   POST /api/fleet/driver/inspection/:jobId
// @access  Private (Driver)
export const startTripWithInspection = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { photos } = req.body; // Expecting array of Cloudinary URLs from frontend

    const job = await Booking.findById(jobId).select("driverId tripStatus");

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (String(job.driverId ?? "") !== driverIdOf(req.user)) {
      return res.status(403).json({ message: "Not authorized for this job" });
    }

    if (!NOT_STARTED.includes(job.tripStatus)) {
      return res.status(400).json({ message: "This trip has already been started." });
    }

    // One trip at a time: a driver can't be on two trips at once.
    const active = await activeTripOf(job.driverId, job._id);
    if (active) {
      return res.status(400).json({
        message: `Complete your current trip (${active.customerName || active.bookingNumber || "in progress"}) first.`,
      });
    }

    // Validate photos array
    if (!photos || !Array.isArray(photos) || photos.length < 6) {
      return res.status(400).json({ message: "At least 6 photos are required to start the trip." });
    }

    const startKm = parseKm(req.body.startKm);
    if (startKm === null) {
      return res.status(400).json({ message: "Enter the vehicle's starting km reading." });
    }

    // Targeted update (not job.save()) so an unrelated invalid field on an old
    // booking can't block the driver. The status condition makes a double tap
    // a no-op instead of overwriting the first reading.
    const updated = await Booking.findOneAndUpdate(
      { _id: jobId, tripStatus: { $in: NOT_STARTED } },
      {
        $set: {
          preTripPhotos: photos,
          tripStatus: "in_progress",
          startKm,
          endKm: null,
          tripStartedAt: new Date(),
          tripCompletedAt: null,
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ message: "This trip has already been started." });
    }

    res.json({ message: "Trip started successfully", job: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Start a later trip of the day without a new inspection
// @route   POST /api/fleet/driver/start-next/:jobId   { startKm }
// @access  Private (Driver)
// The pre-trip inspection is done once per day, on the first trip. Any other
// trip the driver starts that day only needs the starting km.
export const startNextTrip = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await Booking.findById(jobId).select("driverId tripStatus");
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (String(job.driverId ?? "") !== driverIdOf(req.user)) {
      return res.status(403).json({ message: "Not authorized for this job" });
    }
    if (!NOT_STARTED.includes(job.tripStatus)) {
      return res.status(400).json({ message: "This trip has already been started." });
    }

    const { start, end } = istDayBounds(new Date());
    const inspectedToday = await Booking.exists({
      driverId: job.driverId,
      tripStartedAt: { $gte: start, $lt: end },
    });
    if (!inspectedToday) {
      return res.status(400).json({
        message: "Do today's pre-trip inspection first — start your first trip from the inspection screen.",
      });
    }

    const active = await activeTripOf(job.driverId, job._id);
    if (active) {
      return res.status(400).json({
        message: `Complete your current trip (${active.customerName || active.bookingNumber || "in progress"}) first.`,
      });
    }

    const startKm = parseKm(req.body.startKm);
    if (startKm === null) {
      return res.status(400).json({ message: "Enter the vehicle's starting km reading." });
    }

    const updated = await startChainedTrip(jobId, startKm);
    if (!updated) {
      return res.status(400).json({ message: "This trip has already been started." });
    }
    res.json({ message: "Trip started", job: updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Complete a job (driver marks job done, with the ending km)
// @route   POST /api/fleet/driver/complete/:jobId
// @access  Private (Driver)
export const completeJob = async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await Booking.findById(jobId).select(
      "driverId tripStatus startKm vehicleId bookingNumber customerName serviceStart"
    );

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (String(job.driverId ?? "") !== driverIdOf(req.user)) {
      return res.status(403).json({ message: "Not authorized for this job" });
    }

    const { parkedLocation } = req.body;

    if (job.tripStatus !== "in_progress") {
      return res.status(400).json({ message: "Job is not in progress." });
    }

    const endKm = parseKm(req.body.endKm);
    if (endKm === null) {
      return res.status(400).json({ message: "Enter the vehicle's ending km reading." });
    }
    // Trips started before km tracking have no startKm — nothing to compare.
    if (job.startKm != null && endKm < job.startKm) {
      return res.status(400).json({
        message: `Ending km (${endKm}) can't be less than the starting km (${job.startKm}).`,
      });
    }

    // Optional: start the next trip of the same day in the same request, so a
    // driver with several trips never has to start them one by one. Checked
    // before completing, so a bad request changes nothing.
    let nextToStart = null;
    let nextStartKm = null;
    if (req.body.startNextJobId) {
      const pending = await pendingTripsSameDay(job.driverId, job.serviceStart, job._id);
      nextToStart = pending.find((p) => String(p._id) === String(req.body.startNextJobId));
      if (!nextToStart) {
        return res.status(400).json({ message: "That next trip is no longer waiting to start. Refresh and try again." });
      }
      const nextVehicle = nextToStart.vehicleId?._id ?? nextToStart.vehicleId;
      const sameVehicle =
        !nextVehicle || !job.vehicleId || String(nextVehicle) === String(job.vehicleId);
      // Same vehicle: the odometer carries straight over.
      nextStartKm = parseKm(req.body.nextStartKm) ?? (sameVehicle ? endKm : null);
      if (nextStartKm === null) {
        return res.status(400).json({ message: "Enter the starting km for the next trip's vehicle." });
      }
    }

    const updated = await Booking.findOneAndUpdate(
      { _id: jobId, tripStatus: "in_progress" },
      { $set: { tripStatus: "completed", endKm, tripCompletedAt: new Date() } },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ message: "Job is not in progress." });
    }

    if (job.vehicleId) {
      // Odometers only go up: never lower the vehicle's recorded reading.
      await Vehicle.findByIdAndUpdate(job.vehicleId, {
        $max: { currentKm: endKm },
        ...(parkedLocation ? { $set: { parkedLocation } } : {}),
      });
    }

    // Notify fleet managers + admins that the trip is done.
    // Best-effort: the job is already saved, so a notification failure must
    // not turn this into an error (the driver would retry and get a 400).
    await notifyRoles({
      roles: FLEET_MANAGER_ROLES,
      type: "trip_completed",
      title: "Trip completed",
      body: `Job ${job.bookingNumber || ""} for ${job.customerName || "a customer"} was completed.`.replace(/\s+/g, " ").trim(),
      link: "/fleet/completed-works",
      bookingId: job._id,
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    }).catch((e) => console.error("trip_completed notify failed:", e.message));

    let nextStarted = null;
    if (nextToStart) nextStarted = await startChainedTrip(nextToStart._id, nextStartKm);

    // What's left of this driver's day (studio time, not the server's clock).
    const pending = await pendingTripsSameDay(job.driverId, job.serviceStart, job._id);
    const nextJob = nextStarted ?? pending[0] ?? null;
    const isLastJob = !nextStarted && pending.length === 0;

    res.json({
      message: "Job completed successfully",
      job: updated,
      isLastJob,
      nextJob,
      nextStarted: !!nextStarted,
      remainingToday: pending.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// @desc    Report an accident
// @route   POST /api/fleet/driver/accident
// @access  Private (Driver)
export const reportAccident = async (req, res) => {
  try {
    const { vehicleId, jobId, location, photos, description, opposite } = req.body;

    if (!location || !photos || !description) {
      return res.status(400).json({ message: "Location, photos, and description are required." });
    }

    const accident = await AccidentReport.create({
      driver: req.user._id,
      vehicle: vehicleId,
      job: jobId,
      location,
      photos,
      description,
      opposite: {
        name: String(opposite?.name ?? "").trim(),
        phone: String(opposite?.phone ?? "").trim(),
        vehicleNumber: String(opposite?.vehicleNumber ?? "").trim(),
        notes: String(opposite?.notes ?? "").trim(),
      },
      status: "reported",
    });

    if (jobId) {
       await Booking.findByIdAndUpdate(jobId, { tripStatus: 'accident' });
    }

    // Accidents are urgent — alert fleet managers + admins immediately.
    // Best-effort: the report is already saved; don't fail the request.
    await notifyRoles({
      roles: FLEET_MANAGER_ROLES,
      type: "accident_reported",
      title: "Accident reported",
      body: `A driver reported an accident at ${location}.`,
      link: "/fleet/accidents",
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    }).catch((e) => console.error("accident_reported notify failed:", e.message));

    res.status(201).json({ message: "Accident reported successfully", accident });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit driver review
// @route   POST /api/fleet/review
// @access  Private (Artist)
export const submitDriverReview = async (req, res) => {
  try {
    const { driverId, jobId, rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    const review = await DriverReview.create({
      artist: req.user._id,
      driver: driverId,
      job: jobId,
      rating,
      comment,
    });

    res.status(201).json({ message: "Review submitted successfully", review });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all reviews for fleet manager
// @route   GET /api/fleet/manager/reviews
// @access  Private (Admin/Fleet Manager)
export const getDriverReviews = async (req, res) => {
  try {
    const reviews = await DriverReview.find()
      .populate("driver", "name email phone")
      .populate("artist", "name")
      .populate("job", "bookingNumber service")
      .sort({ createdAt: -1 });
      
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all accidents for fleet manager
// @route   GET /api/fleet/manager/accidents
// @access  Private (Admin/Fleet Manager)
export const getAccidentReports = async (req, res) => {
  try {
    const accidents = await AccidentReport.find()
      .populate("driver", "name phone")
      .populate("vehicle", "registrationNumber type")
      .populate("job", "bookingNumber")
      .sort({ createdAt: -1 });

    res.json(accidents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// @desc    Get all completed works for fleet manager
// @route   GET /api/fleet/manager/completed-works
// @access  Private (Admin/Fleet Manager)
export const getCompletedWorks = async (req, res) => {
  try {
    const completedJobs = await Booking.find({ tripStatus: "completed" })
      .populate("driverId", "name phone employeeId")
      .populate("vehicleId", "registrationNumber type")
      .sort({ updatedAt: -1 });
    
    res.json(completedJobs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all service reminders
// @route   GET /api/fleet/manager/service-reminders
// @access  Private (Admin/Fleet Manager)
export const getServiceReminders = async (req, res) => {
  try {
    const reminders = await ServiceReminder.find()
      .populate("vehicle", "name registrationNumber type currentKm mileage")
      .sort({ dueDate: 1, dueKm: 1 });
      
    res.json(reminders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add a service reminder
// @route   POST /api/fleet/manager/service-reminders
// @access  Private (Admin/Fleet Manager)
export const addServiceReminder = async (req, res) => {
  try {
    const { vehicle, serviceType, dueDate, dueKm, notes } = req.body;

    if (!vehicle || !serviceType) {
      return res.status(400).json({ message: "Vehicle and Service Type are required." });
    }

    if (!dueDate && !dueKm) {
      return res.status(400).json({ message: "Either Due Date or Due KM must be provided." });
    }

    const reminder = await ServiceReminder.create({
      vehicle,
      serviceType,
      dueDate,
      dueKm,
      notes,
      status: "pending"
    });

    // Populate vehicle for immediate frontend response
    await reminder.populate("vehicle", "name registrationNumber type currentKm mileage");

    res.status(201).json({ message: "Service reminder created", reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Complete a service reminder
// @route   POST /api/fleet/manager/service-reminders/:id/complete
// @access  Private (Admin/Fleet Manager)
export const completeServiceReminder = async (req, res) => {
  try {
    const reminder = await ServiceReminder.findById(req.params.id);

    if (!reminder) {
      return res.status(404).json({ message: "Service reminder not found" });
    }

    reminder.status = "completed";
    await reminder.save();
    await reminder.populate("vehicle", "name registrationNumber type currentKm mileage");

    res.json({ message: "Service reminder marked as completed", reminder });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Km report ──────────────────────────────────────────────────────────────

// 'YYYY-MM-DD' → the start of that day in studio time (IST), or null.
const istDayStart = (key) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key ?? ""))) return null;
  const d = new Date(`${key}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const round1 = (n) => Math.round(n * 10) / 10;

// @desc    Km driven per driver / vehicle over a custom date range
// @route   GET /api/fleet/manager/km-report?from=YYYY-MM-DD&to=YYYY-MM-DD
// @access  Private (Admin/Fleet Manager)
// A trip counts on the day it was completed (studio time), and only when both
// odometer readings were recorded. Both dates are inclusive.
export const getKmReport = async (req, res) => {
  try {
    const DAY = 86400000;
    const toStart = istDayStart(req.query.to) ?? istDayStart(
      new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)
    );
    const fromStart = istDayStart(req.query.from) ?? new Date(toStart.getTime() - 29 * DAY);
    if (fromStart > toStart) {
      return res.status(400).json({ message: "The start date must be on or before the end date." });
    }
    const end = new Date(toStart.getTime() + DAY); // exclusive

    const completed = await Booking.find({
      tripStatus: "completed",
      tripCompletedAt: { $gte: fromStart, $lt: end },
    })
      .select("bookingNumber customerName service driverId vehicleId startKm endKm tripStartedAt tripCompletedAt")
      .populate("driverId", "name")
      .populate("vehicleId", "name registrationNumber type")
      .sort({ tripCompletedAt: -1 })
      .lean();

    const trips = [];
    let untracked = 0;
    const drivers = new Map();
    const vehicles = new Map();
    for (const b of completed) {
      if (b.startKm == null || b.endKm == null || b.endKm < b.startKm) {
        untracked += 1;
        continue;
      }
      const km = round1(b.endKm - b.startKm);
      const driverId = b.driverId?._id ? String(b.driverId._id) : "";
      const vehicleId = b.vehicleId?._id ? String(b.vehicleId._id) : "";
      trips.push({
        bookingId: b._id,
        bookingNumber: b.bookingNumber ?? "",
        customerName: b.customerName ?? "",
        service: b.service ?? "",
        driverId,
        driverName: b.driverId?.name ?? "",
        vehicleId,
        vehicleName: b.vehicleId?.name ?? "",
        registrationNumber: b.vehicleId?.registrationNumber ?? "",
        startKm: b.startKm,
        endKm: b.endKm,
        km,
        completedAt: b.tripCompletedAt,
      });
      if (driverId) {
        const d = drivers.get(driverId) ?? { driverId, name: b.driverId?.name ?? "", trips: 0, km: 0 };
        d.trips += 1;
        d.km = round1(d.km + km);
        drivers.set(driverId, d);
      }
      if (vehicleId) {
        const v = vehicles.get(vehicleId) ?? {
          vehicleId,
          name: b.vehicleId?.name ?? "",
          registrationNumber: b.vehicleId?.registrationNumber ?? "",
          trips: 0,
          km: 0,
          fuelSpend: 0,
        };
        v.trips += 1;
        v.km = round1(v.km + km);
        vehicles.set(vehicleId, v);
      }
    }

    // Fuel bought for these vehicles in the same range → approximate cost/km.
    if (vehicles.size) {
      const fuel = await FuelExpense.aggregate([
        {
          $match: {
            category: "fuel",
            date: { $gte: fromStart, $lt: end },
            vehicleId: { $in: [...vehicles.keys()].map((id) => new mongoose.Types.ObjectId(id)) },
          },
        },
        { $group: { _id: "$vehicleId", spend: { $sum: "$totalAmount" } } },
      ]);
      for (const f of fuel) {
        const v = vehicles.get(String(f._id));
        if (v) v.fuelSpend = Math.round(f.spend);
      }
    }

    const byKm = (a, b) => b.km - a.km || b.trips - a.trips;
    const totalKm = round1(trips.reduce((s, t) => s + t.km, 0));
    res.json({
      from: fromStart,
      to: toStart,
      totals: {
        km: totalKm,
        trips: trips.length,
        untrackedTrips: untracked,
        avgKmPerTrip: trips.length ? round1(totalKm / trips.length) : 0,
      },
      drivers: [...drivers.values()].sort(byKm),
      vehicles: [...vehicles.values()]
        .map((v) => ({ ...v, costPerKm: v.km > 0 && v.fuelSpend > 0 ? round1(v.fuelSpend / v.km) : null }))
        .sort(byKm),
      trips,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
