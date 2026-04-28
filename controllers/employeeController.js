import Employee from '../models/Employee.js';
import mongoose from 'mongoose';

const normalizeWorks = (works, fallbackSpecialization = '') => {
  if (Array.isArray(works)) {
    return [
      ...new Set(
        works
          .map((item) => String(item ?? '').trim())
          .filter(Boolean)
      ),
    ];
  }

  const normalizedFallback = String(fallbackSpecialization ?? '').trim();
  return normalizedFallback ? [normalizedFallback] : [];
};

const normalizeEmail = (email) => {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  return normalizedEmail;
};

const normalizeRegionId = (regionId) => {
  const normalizedRegionId = String(regionId ?? '').trim();
  if (!normalizedRegionId) {
    return null;
  }

  return mongoose.Types.ObjectId.isValid(normalizedRegionId)
    ? normalizedRegionId
    : null;
};

const handleEmployeeSaveError = (error, res) => {
  if (error?.code === 11000) {
    return res.status(400).json({
      message:
        'A staff member with the same unique details already exists. Please use a different email or phone.',
    });
  }

  return res.status(500).json({ message: error.message });
};

// @desc    Get all employees
// @route   GET /api/employees
// @access  Public (for now)
export const getEmployees = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const query = {};
      if (req.query.category) {
        if (req.query.category === 'creative') {
          query.category = { $ne: 'administrative' };
        } else {
          query.category = req.query.category;
        }
      }

      const [items, totalItems] = await Promise.all([
        Employee.find(query)
          .populate('regionId', 'name status')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(currentLimit),
        Employee.countDocuments(query),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const query = {};
    if (req.query.category) {
      if (req.query.category === 'creative') {
        query.category = { $ne: 'administrative' };
      } else {
        query.category = req.query.category;
      }
    }

    const employees = await Employee.find(query)
      .populate('regionId', 'name status')
      .sort({ createdAt: -1 });
    res.json(employees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create an employee
// @route   POST /api/employees
// @access  Public (for now)
export const createEmployee = async (req, res) => {
  const {
    name,
    email,
    type,
    artistRole,
    specialization,
    works,
    phone,
    status,
    regionId,
    category,
  } = req.body;

  try {
    const normalizedEmail = normalizeEmail(email);
    const normalizedRegionId = normalizeRegionId(regionId);

    if (normalizedEmail) {
      const employeeExists = await Employee.findOne({ email: normalizedEmail });
      if (employeeExists) {
        return res.status(400).json({ message: 'Employee already exists' });
      }
    }

    const normalizedWorks = normalizeWorks(works, specialization);
    const normalizedSpecialization =
      normalizedWorks[0] ?? String(specialization ?? '').trim();

    const employee = await Employee.create({
      name,
      email: normalizedEmail,
      type: type ?? 'outsource',
      artistRole: artistRole ?? 'artist',
      specialization: normalizedSpecialization,
      works: normalizedWorks,
      phone: phone ?? '',
      status: status ?? 'active',
      regionId: normalizedRegionId,
      role: normalizedSpecialization,
      department: 'Staff',
      category: category ?? 'creative',
    });

    const populatedEmployee = await Employee.findById(employee._id).populate(
      'regionId',
      'name status'
    );

    res.status(201).json(populatedEmployee);
  } catch (error) {
    return handleEmployeeSaveError(error, res);
  }
};

export const updateEmployee = async (req, res) => {
  const {
    name,
    email,
    type,
    artistRole,
    specialization,
    works,
    phone,
    status,
    regionId,
    category,
  } = req.body;

  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedRegionId = normalizeRegionId(regionId);

    if (normalizedEmail && normalizedEmail != employee.email) {
      const employeeExists = await Employee.findOne({ email: normalizedEmail });
      if (employeeExists) {
        return res.status(400).json({ message: 'Employee already exists' });
      }
    }

    const normalizedWorks =
      works != null
        ? normalizeWorks(works, specialization)
        : employee.works ?? normalizeWorks([], employee.specialization);
    const normalizedSpecialization =
      specialization != null
        ? String(specialization ?? '').trim()
        : employee.specialization;
    const effectiveSpecialization =
      normalizedSpecialization || normalizedWorks[0] || '';

    employee.name = name ?? employee.name;
    employee.email =
      email != null ? normalizedEmail : employee.email;
    employee.type = type ?? employee.type;
    employee.artistRole = artistRole ?? employee.artistRole;
    employee.specialization = effectiveSpecialization;
    employee.works = normalizedWorks;
    employee.phone = phone ?? employee.phone;
    employee.status = status ?? employee.status;
    employee.regionId = regionId != null ? normalizedRegionId : employee.regionId;
    employee.role = effectiveSpecialization || employee.role;
    employee.department = 'Staff';
    employee.category = category ?? employee.category;

    await employee.save();

    const populatedEmployee = await Employee.findById(employee._id).populate(
      'regionId',
      'name status'
    );

    res.json(populatedEmployee);
  } catch (error) {
    return handleEmployeeSaveError(error, res);
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    await employee.deleteOne();
    res.json({ message: 'Employee removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
