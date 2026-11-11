import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import { CATEGORY_KEYS, defaultSeatsFor } from '../utils/vehicleCategories.js';

const normalizeObjectId = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : null;
};

const normalizeRegistrationNumber = (value) =>
  String(value ?? '').trim().toUpperCase();

// Category / seats / fuel-efficiency fields from the request. `undefined` means
// "not sent — leave as is"; a bad value is an error (never silently stored).
// Returns { fields } with only the sent, valid ones, or { error }.
const NUMBER_FIELDS = [
  ['seats', 'Seats', 60, true],
  ['ratedMileage', 'Rated mileage', 500, false],
  ['tankCapacity', 'Tank capacity', 1000, false],
];
const parseProfileFields = (body) => {
  const fields = {};
  if (body.category !== undefined && body.category !== null) {
    const category = String(body.category).trim();
    if (category && !CATEGORY_KEYS.includes(category)) {
      return { error: `Unknown vehicle category "${category}".` };
    }
    fields.category = category;
  }
  for (const [key, label, max, whole] of NUMBER_FIELDS) {
    const raw = body[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n))) {
      return { error: `${label} must be ${whole ? 'a whole number' : 'a number'} between 0 and ${max}.` };
    }
    fields[key] = n;
  }
  return { fields };
};

const handleVehicleError = (error, res) => {
  if (error?.code === 11000) {
    return res.status(400).json({
      message: 'A vehicle with the same registration number already exists.',
    });
  }

  return res.status(500).json({ message: error.message });
};

const vehiclePopulate = [
  { path: 'driverId', select: 'name phone artistRole status' },
];

export const getVehicles = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Vehicle.find({})
          .populate(vehiclePopulate)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(currentLimit),
        Vehicle.countDocuments({}),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const vehicles = await Vehicle.find({})
      .populate(vehiclePopulate)
      .sort({ createdAt: -1 });
    res.json(vehicles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createVehicle = async (req, res) => {
  const {
    name,
    registrationNumber,
    type,
    brand,
    fuelType,
    driverId,
    status,
    notes,
    ownershipType,
  } = req.body;

  try {
    const profile = parseProfileFields(req.body);
    if (profile.error) return res.status(400).json({ message: profile.error });
    // A category on its own brings its usual seat count.
    if (profile.fields.category && profile.fields.seats === undefined) {
      profile.fields.seats = defaultSeatsFor(profile.fields.category);
    }

    const vehicle = await Vehicle.create({
      ...profile.fields,
      name,
      registrationNumber: normalizeRegistrationNumber(registrationNumber),
      type: type ?? 'car',
      brand: brand ?? '',
      fuelType: fuelType ?? 'petrol',
      driverId: normalizeObjectId(driverId),
      // 'running' is the model's valid default; 'active' is not in the enum and
      // made a status-less create fail validation (vehicle never saved).
      status: status ?? 'running',
      notes: notes ?? '',
      ownershipType: ownershipType ?? 'in_house',
    });

    const populated = await Vehicle.findById(vehicle._id).populate(vehiclePopulate);
    res.status(201).json(populated);
  } catch (error) {
    return handleVehicleError(error, res);
  }
};

export const updateVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    const {
      name,
      registrationNumber,
      type,
      brand,
      fuelType,
      driverId,
      status,
      notes,
      ownershipType,
    } = req.body;

    vehicle.name = name ?? vehicle.name;
    vehicle.registrationNumber =
      registrationNumber != null
        ? normalizeRegistrationNumber(registrationNumber)
        : vehicle.registrationNumber;
    vehicle.type = type ?? vehicle.type;
    vehicle.brand = brand ?? vehicle.brand;
    vehicle.fuelType = fuelType ?? vehicle.fuelType;
    vehicle.driverId =
      driverId != null ? normalizeObjectId(driverId) : vehicle.driverId;
    vehicle.status = status ?? vehicle.status;
    vehicle.notes = notes ?? vehicle.notes;
    vehicle.ownershipType = ownershipType ?? vehicle.ownershipType;

    const profile = parseProfileFields(req.body);
    if (profile.error) return res.status(400).json({ message: profile.error });
    // Choosing a category for a vehicle with no seat count recorded fills it in.
    if (profile.fields.category && profile.fields.seats === undefined && !vehicle.seats) {
      profile.fields.seats = defaultSeatsFor(profile.fields.category);
    }
    Object.assign(vehicle, profile.fields);

    await vehicle.save();

    const populated = await Vehicle.findById(vehicle._id).populate(vehiclePopulate);
    res.json(populated);
  } catch (error) {
    return handleVehicleError(error, res);
  }
};

export const deleteVehicle = async (req, res) => {
  try {
    const vehicle = await Vehicle.findById(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    await vehicle.deleteOne();
    res.json({ message: 'Vehicle removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
