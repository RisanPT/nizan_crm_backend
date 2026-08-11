import Employee from '../models/Employee.js';
import SalaryIncrement from '../models/SalaryIncrement.js';
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

    const query = {};
    const andConditions = [];

    if (req.query.category && req.query.category !== 'all') {
      if (req.query.category === 'admin' || req.query.category === 'administrative') {
        andConditions.push({
          category: { $in: ['admin', 'administrative', 'it', 'marketing', 'sales', 'finance', 'accounts', 'crm', 'hr'] },
          artistRole: { $nin: ['driver', 'artist', 'assistant'] },
        });
      } else if (req.query.category === 'operations' || req.query.category === 'creative') {
        andConditions.push({
          $or: [
            { category: { $in: ['operations', 'creative'] } },
            { artistRole: { $in: ['driver', 'artist', 'assistant'] } },
            { category: { $exists: false } },
            { category: null },
          ],
        });
      } else {
        andConditions.push({ category: req.query.category });
      }
    }

    if (req.query.department && req.query.department !== 'All' && req.query.department !== 'all') {
      andConditions.push({ department: req.query.department });
    }

    if (req.query.artistRole && req.query.artistRole !== 'All' && req.query.artistRole !== 'all') {
      andConditions.push({ artistRole: req.query.artistRole });
    }

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, 'i');
      andConditions.push({
        $or: [
          { name: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { specialization: searchRegex },
          { role: searchRegex },
          { department: searchRegex },
        ]
      });
    }

    if (req.query.zoneId) {
      andConditions.push({ zoneId: req.query.zoneId });
    }
    if (req.query.stateId) {
      andConditions.push({ stateId: req.query.stateId });
    }
    if (req.query.regionId) {
      andConditions.push({ regionId: req.query.regionId });
    }
    if (req.query.districtId) {
      andConditions.push({ districtId: req.query.districtId });
    }
    if (req.query.pincodeId) {
      andConditions.push({ pincodeId: req.query.pincodeId });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Employee.find(query)
          .populate('regionId', 'name status')
          .populate('zoneId', 'name status')
          .populate('stateId', 'name status')
          .populate('districtId', 'name status')
          .populate('pincodeId', 'code status')
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

    const employees = await Employee.find(query)
      .populate('regionId', 'name status')
      .populate('zoneId', 'name status')
      .populate('stateId', 'name status')
      .populate('districtId', 'name status')
      .populate('pincodeId', 'code status')
      .sort({ createdAt: -1 });
    res.json(employees);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single employee
// @route   GET /api/employees/:id
// @access  Public (for now)
export const getEmployee = async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id)
      .populate('regionId', 'name status')
      .populate('zoneId', 'name status')
      .populate('stateId', 'name status')
      .populate('districtId', 'name status')
      .populate('pincodeId', 'code status');
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    res.json(employee);
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
    zoneId,
    stateId,
    districtId,
    pincodeId,
    category,
    department,
    profileImage,
    salaryType,
    baseSalary,
    allowances,
    deductions,
    hra,
    hraDay,
    bankName,
    accountNumber,
    ifscCode,
    upiId,
    panNumber,
  } = req.body;

  try {
    const normalizedEmail = normalizeEmail(email);
    const normalizedRegionId = normalizeRegionId(regionId);
    const normalizedZoneId = normalizeRegionId(zoneId);
    const normalizedStateId = normalizeRegionId(stateId);
    const normalizedDistrictId = normalizeRegionId(districtId);
    const normalizedPincodeId = normalizeRegionId(pincodeId);

    if (normalizedEmail) {
      const employeeExists = await Employee.findOne({ email: normalizedEmail });
      if (employeeExists) {
        return res.status(400).json({ message: 'Employee already exists' });
      }
    }

    const normalizedWorks = normalizeWorks(works, specialization);
    const normalizedSpecialization =
      normalizedWorks[0] ?? String(specialization ?? '').trim();

    const effectiveRole = req.body.role || normalizedSpecialization || 'Staff';
    const effectiveCategory = category ?? (['artist', 'assistant', 'driver'].includes(artistRole) ? 'operations' : 'administrative');
    const effectiveDepartment = department ?? (effectiveCategory === 'operations' ? 'Operations' : 'General');

    const employee = await Employee.create({
      name,
      email: normalizedEmail,
      type: type ?? 'in-house',
      artistRole: artistRole ?? (effectiveCategory === 'operations' ? 'artist' : 'staff'),
      specialization: normalizedSpecialization || effectiveRole,
      works: normalizedWorks,
      phone: phone ?? '',
      status: status ?? 'active',
      regionId: normalizedRegionId,
      zoneId: normalizedZoneId,
      stateId: normalizedStateId,
      districtId: normalizedDistrictId,
      pincodeId: normalizedPincodeId,
      role: effectiveRole,
      department: effectiveDepartment,
      category: effectiveCategory,
      profileImage: profileImage ?? '',
      salaryType: salaryType ?? (effectiveCategory === 'operations' ? 'per_booking' : 'fixed_monthly'),
      baseSalary: Number(baseSalary) || 0,
      allowances: Number(allowances) || 0,
      deductions: Number(deductions) || 0,
      hra: Number(hra) || 0,
      hraDay: Number(hraDay) || 0,
      bankName: bankName ?? '',
      accountNumber: accountNumber ?? '',
      ifscCode: ifscCode ?? '',
      upiId: upiId ?? '',
      panNumber: panNumber ?? '',
    });

    const populatedEmployee = await Employee.findById(employee._id)
      .populate('regionId', 'name status')
      .populate('zoneId', 'name status')
      .populate('stateId', 'name status')
      .populate('districtId', 'name status')
      .populate('pincodeId', 'code status');

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
    zoneId,
    stateId,
    districtId,
    pincodeId,
    role,
    category,
    department,
    profileImage,
    salaryType,
    baseSalary,
    allowances,
    deductions,
    hra,
    hraDay,
    bankName,
    accountNumber,
    ifscCode,
    upiId,
    panNumber,
  } = req.body;

  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedRegionId = normalizeRegionId(regionId);
    const normalizedZoneId = normalizeRegionId(zoneId);
    const normalizedStateId = normalizeRegionId(stateId);
    const normalizedDistrictId = normalizeRegionId(districtId);
    const normalizedPincodeId = normalizeRegionId(pincodeId);

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
    employee.zoneId = zoneId != null ? normalizedZoneId : employee.zoneId;
    employee.stateId = stateId != null ? normalizedStateId : employee.stateId;
    employee.districtId = districtId != null ? normalizedDistrictId : employee.districtId;
    employee.pincodeId = pincodeId != null ? normalizedPincodeId : employee.pincodeId;
    employee.role = role ?? effectiveSpecialization ?? employee.role;
    employee.department = department ?? employee.department ?? 'Operations';
    employee.category = category ?? employee.category ?? 'operations';
    employee.profileImage = profileImage ?? employee.profileImage;
    if (salaryType !== undefined) employee.salaryType = salaryType;
    if (baseSalary !== undefined) employee.baseSalary = Number(baseSalary) || 0;
    if (allowances !== undefined) employee.allowances = Number(allowances) || 0;
    if (deductions !== undefined) employee.deductions = Number(deductions) || 0;
    if (hra !== undefined) employee.hra = Number(hra) || 0;
    if (hraDay !== undefined) employee.hraDay = Number(hraDay) || 0;
    if (bankName !== undefined) employee.bankName = bankName;
    if (accountNumber !== undefined) employee.accountNumber = accountNumber;
    if (ifscCode !== undefined) employee.ifscCode = ifscCode;
    if (upiId !== undefined) employee.upiId = upiId;
    if (panNumber !== undefined) employee.panNumber = panNumber;

    await employee.save();

    const populatedEmployee = await Employee.findById(employee._id)
      .populate('regionId', 'name status')
      .populate('zoneId', 'name status')
      .populate('stateId', 'name status')
      .populate('districtId', 'name status')
      .populate('pincodeId', 'code status');

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

// @desc    Get employee salary increments
// @route   GET /api/employees/:id/increments
// @access  Private
export const getEmployeeIncrements = async (req, res) => {
  try {
    const increments = await SalaryIncrement.find({ employeeId: req.params.id })
      .populate('appliedBy', 'name')
      .sort({ createdAt: -1 });
    res.json(increments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Add employee salary increment
// @route   POST /api/employees/:id/increments
// @access  Private
export const addEmployeeIncrement = async (req, res) => {
  const { newSalary, reason, effectiveDate } = req.body;
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const previousSalary = employee.baseSalary;

    const increment = await SalaryIncrement.create({
      employeeId: employee._id,
      previousSalary,
      newSalary,
      reason,
      effectiveDate: effectiveDate || Date.now(),
      appliedBy: req.user?._id || null,
    });

    employee.baseSalary = newSalary;
    await employee.save();

    res.status(201).json(increment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
