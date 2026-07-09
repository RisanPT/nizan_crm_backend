import Booking from "../models/Booking.js";
import AccidentReport from "../models/AccidentReport.js";
import DriverReview from "../models/DriverReview.js";
import ServiceReminder from "../models/ServiceReminder.js";
import Vehicle from "../models/Vehicle.js";

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
        'travelDistanceKm pocName pocPhone assignedStaff bookingItems'
      )
      .populate('vehicleId', 'registrationNumber type')
      .sort({ serviceStart: 1 });

    res.json(jobs);
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Upload pre-trip photos and start trip
// @route   POST /api/fleet/driver/inspection/:jobId
// @access  Private (Driver)
export const startTripWithInspection = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { photos } = req.body; // Expecting array of Cloudinary URLs from frontend

    const job = await Booking.findById(jobId);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const driverIdStr = req.user.employeeId ? req.user.employeeId.toString() : req.user._id.toString();
    if (job.driverId.toString() !== driverIdStr) {
      return res.status(403).json({ message: "Not authorized for this job" });
    }

    // Validate photos array
    if (!photos || !Array.isArray(photos) || photos.length < 6) {
      return res.status(400).json({ message: "At least 6 photos are required to start the trip." });
    }

    // Always save preTripPhotos and mark trip as in_progress
    job.preTripPhotos = photos;
    job.tripStatus = "in_progress";
    await job.save();

    res.json({ message: "Trip started successfully", job });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Complete a job (driver marks job done)
// @route   POST /api/fleet/driver/complete/:jobId
// @access  Private (Driver)
export const completeJob = async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await Booking.findById(jobId);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const driverIdStr = req.user.employeeId ? req.user.employeeId.toString() : req.user._id.toString();
    if (job.driverId.toString() !== driverIdStr) {
      return res.status(403).json({ message: "Not authorized for this job" });
    }

    const { parkedLocation } = req.body;

    if (job.tripStatus !== "in_progress") {
      return res.status(400).json({ message: "Job is not in progress." });
    }

    job.tripStatus = "completed";
    await job.save();

    if (parkedLocation && job.vehicleId) {
      await Vehicle.findByIdAndUpdate(job.vehicleId, { parkedLocation: parkedLocation });
    }

    // Check if there are remaining jobs for today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const remainingJobs = await Booking.countDocuments({
      driverId: job.driverId,
      serviceStart: { $gte: startOfDay, $lte: endOfDay },
      tripStatus: { $in: ["unassigned", "assigned", "in_progress"] },
      _id: { $ne: job._id }
    });

    const isLastJob = remainingJobs === 0;

    res.json({ 
      message: "Job completed successfully", 
      job, 
      isLastJob 
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
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

    res.status(201).json({ message: "Accident reported successfully", accident });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
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
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
