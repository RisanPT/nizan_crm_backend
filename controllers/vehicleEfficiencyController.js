import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.js';
import FuelExpense from '../models/FuelExpense.js';
import Booking from '../models/Booking.js';
import { computeEfficiency } from '../utils/fuelEfficiency.js';
import { VEHICLE_CATEGORIES } from '../utils/vehicleCategories.js';

// Roles that oversee the fleet (same set as controllers/fleetController.js).
const FLEET_ROLES = ['fleet_manager', 'admin', 'manager'];

export const fleetRolesOnly = (req, res, next) =>
  req.user && FLEET_ROLES.includes(req.user.role)
    ? next()
    : res.status(403).json({ message: 'Not authorized to view fleet fuel efficiency' });

const DAY_MS = 86400000;

/// ?days= — how far back to look (default 365, kept to 30–730).
const sinceFromQuery = (req) => {
  const n = Number.parseInt(req.query.days, 10);
  const days = Number.isFinite(n) ? Math.min(730, Math.max(30, n)) : 365;
  return { days, since: new Date(Date.now() - days * DAY_MS) };
};

// Fuel bills still count while pending; rejected ones never happened.
const fuelFilter = (since) => ({ category: 'fuel', status: { $ne: 'rejected' }, date: { $gte: since } });

const tripKm = (b) =>
  b.startKm != null && b.endKm != null && b.endKm >= b.startKm
    ? { km: b.endKm - b.startKm, completedAt: b.tripCompletedAt }
    : null;

const completedTripsFilter = (since) => ({
  tripStatus: 'completed',
  startKm: { $ne: null },
  endKm: { $ne: null },
  tripCompletedAt: { $gte: since },
});

const efficiencyOf = (vehicle, fills, trips) =>
  computeEfficiency({
    fills,
    trips,
    ratedMileage: vehicle.ratedMileage,
    tankCapacity: vehicle.tankCapacity,
    fuelType: vehicle.fuelType,
  });

// @desc    The vehicle categories (key, label, usual passenger seats)
// @route   GET /api/vehicles/categories
export const getVehicleCategories = (_req, res) => res.json(VEHICLE_CATEGORIES);

// @desc    One vehicle's fuel efficiency: actual vs rated, cost per km, range, monthly trend
// @route   GET /api/vehicles/:id/efficiency?days=
export const getVehicleEfficiency = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }
    const vehicle = await Vehicle.findById(req.params.id).lean();
    if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' });

    const { days, since } = sinceFromQuery(req);
    const [fills, trips] = await Promise.all([
      FuelExpense.find({ vehicleId: vehicle._id, ...fuelFilter(since) })
        .select('date odometerKm liters totalAmount')
        .lean(),
      Booking.find({ vehicleId: vehicle._id, ...completedTripsFilter(since) })
        .select('startKm endKm tripCompletedAt')
        .lean(),
    ]);

    res.json({
      vehicleId: vehicle._id,
      name: vehicle.name,
      registrationNumber: vehicle.registrationNumber,
      category: vehicle.category || '',
      seats: vehicle.seats || 0,
      fuelType: vehicle.fuelType,
      currentKm: vehicle.currentKm ?? null,
      days,
      ...efficiencyOf(vehicle, fills, trips.map(tripKm).filter(Boolean)),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Every vehicle's fuel-efficiency headline, worst performers first
// @route   GET /api/vehicles/efficiency?days=
export const getFleetEfficiency = async (req, res) => {
  try {
    const { days, since } = sinceFromQuery(req);
    const [vehicles, fills, trips] = await Promise.all([
      Vehicle.find({}).lean(),
      FuelExpense.find({ vehicleId: { $ne: null }, ...fuelFilter(since) })
        .select('vehicleId date odometerKm liters totalAmount')
        .lean(),
      Booking.find({ vehicleId: { $ne: null }, ...completedTripsFilter(since) })
        .select('vehicleId startKm endKm tripCompletedAt')
        .lean(),
    ]);

    const group = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = String(r.vehicleId);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const fillsBy = group(fills);
    const tripsBy = group(trips);

    const rank = { poor: 0, watch: 1, good: 2, unknown: 3 };
    const items = vehicles
      .map((v) => {
        const id = String(v._id);
        // `intervals` and `monthly` are for the detail view; the list stays light.
        const { intervals, monthly, ...headline } = efficiencyOf(
          v,
          fillsBy.get(id) ?? [],
          (tripsBy.get(id) ?? []).map(tripKm).filter(Boolean),
        );
        return {
          vehicleId: v._id,
          name: v.name,
          registrationNumber: v.registrationNumber,
          category: v.category || '',
          seats: v.seats || 0,
          fuelType: v.fuelType,
          vehicleStatus: v.status,
          ...headline,
        };
      })
      .sort((a, b) => rank[a.status] - rank[b.status] || (a.vsRatedPercent ?? 999) - (b.vsRatedPercent ?? 999));

    const measured = items.filter((i) => i.actual != null);
    res.json({
      days,
      summary: {
        vehicles: items.length,
        measured: measured.length,
        poor: items.filter((i) => i.status === 'poor').length,
        watch: items.filter((i) => i.status === 'watch').length,
        good: items.filter((i) => i.status === 'good').length,
        missingRatedMileage: vehicles.filter((v) => !(v.ratedMileage > 0)).length,
        fuelSpend: items.reduce((s, i) => s + (i.fuelSpend || 0), 0),
      },
      items,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
