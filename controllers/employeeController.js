import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import Designation from '../models/Designation.js';
import SalaryIncrement from '../models/SalaryIncrement.js';
import mongoose from 'mongoose';
import { flatGeoMatch, isFullGeoAccess } from '../utils/geoScope.js';
import { performTimeboxEmployeeSync } from './timeboxController.js';

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
      const deptTerm = String(req.query.department).trim();
      if (/^it$/i.test(deptTerm) || /technology/i.test(deptTerm)) {
        andConditions.push({
          $or: [
            { department: /^it$/i },
            { department: /technology/i },
            { category: 'it' }
          ]
        });
      } else {
        andConditions.push({ department: new RegExp(`^${deptTerm}$`, 'i') });
      }
    }

    if (req.query.artistRole && req.query.artistRole !== 'All' && req.query.artistRole !== 'all') {
      andConditions.push({ artistRole: req.query.artistRole });
    }

    if (req.query.employmentStatus && req.query.employmentStatus !== 'All' && req.query.employmentStatus !== 'all') {
      andConditions.push({ employmentStatus: req.query.employmentStatus });
    }

    if (req.query.currentGrade && req.query.currentGrade !== 'All' && req.query.currentGrade !== 'all') {
      andConditions.push({ currentGrade: req.query.currentGrade.toUpperCase() });
    }

    if (req.query.timeboxStatus && req.query.timeboxStatus !== 'All' && req.query.timeboxStatus !== 'all') {
      if (req.query.timeboxStatus === 'linked') {
        andConditions.push({ timeboxEmployeeId: { $ne: null } });
      } else if (req.query.timeboxStatus === 'unlinked') {
        andConditions.push({ timeboxEmployeeId: null });
      }
    }

    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, 'i');
      const orList = [
        { employeeCode: searchRegex },
        { name: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { specialization: searchRegex },
        { role: searchRegex },
        { department: searchRegex },
        { timeboxName: searchRegex },
      ];
      const parsedNum = Number(req.query.search);
      if (!Number.isNaN(parsedNum)) {
        orList.push({ timeboxEmployeeId: parsedNum });
      }
      andConditions.push({ $or: orList });
    }

    // Territory scoping. A full-access user (admin/manager) may filter by any
    // geo via query params. A scoped user is LOCKED to their own territory and
    // cannot widen it — their query params are ignored and their own geo wins.
    if (isFullGeoAccess(req.user)) {
      if (req.query.zoneId) andConditions.push({ zoneId: req.query.zoneId });
      if (req.query.stateId) andConditions.push({ stateId: req.query.stateId });
      if (req.query.regionId) andConditions.push({ regionId: req.query.regionId });
      if (req.query.districtId) andConditions.push({ districtId: req.query.districtId });
      if (req.query.pincodeId) andConditions.push({ pincodeId: req.query.pincodeId });
    } else {
      const geo = flatGeoMatch(req.user);
      if (Object.keys(geo).length) andConditions.push(geo);
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
    employeeCode,
    dateOfBirth,
    dateOfJoining,
    probationEndDate,
    employmentStatus,
    emergencyContact,
    currentGrade,
    overtimeRate,
    statutoryApplicability,
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

    const employeeData = {
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
      departmentId: req.body.departmentId || null,
      reportingManagerId: req.body.reportingManagerId || null,
      designationId: req.body.designationId || null,
      employmentStatus: employmentStatus || 'probation',
      currentGrade: (currentGrade || 'B').toUpperCase(),
      overtimeRate: Number(overtimeRate) || 0,
      statutoryApplicability: statutoryApplicability || { epf: false, esi: false, uan: '', esiNumber: '' },
      timeboxEmployeeId: req.body.timeboxEmployeeId != null && req.body.timeboxEmployeeId !== ''
        ? Number(req.body.timeboxEmployeeId)
        : null,
      timeboxName: req.body.timeboxName ? String(req.body.timeboxName).trim() : '',
    };

    if (employeeCode) employeeData.employeeCode = employeeCode.trim().toUpperCase();
    if (dateOfBirth) employeeData.dateOfBirth = new Date(dateOfBirth);
    if (dateOfJoining) employeeData.dateOfJoining = new Date(dateOfJoining);
    if (probationEndDate) employeeData.probationEndDate = new Date(probationEndDate);
    if (emergencyContact) employeeData.emergencyContact = emergencyContact;

    const employee = await Employee.create(employeeData);

    const populatedEmployee = await Employee.findById(employee._id)
      .populate('regionId', 'name status')
      .populate('zoneId', 'name status')
      .populate('stateId', 'name status')
      .populate('districtId', 'name status')
      .populate('pincodeId', 'code status');

    // Trigger async Timebox sync so any matching Timebox profile is bound immediately
    performTimeboxEmployeeSync().catch((err) =>
      console.error('[Timebox] Background sync after employee creation failed:', err?.message || err)
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
    // Preserve the existing role when an update omits it — previously it fell
    // through to `effectiveSpecialization` (always a string), so editing only a
    // phone/status silently overwrote (or wiped) the employee's role.
    employee.role = role ?? employee.role ?? effectiveSpecialization;
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
    if (req.body.departmentId !== undefined) employee.departmentId = req.body.departmentId || null;
    if (req.body.reportingManagerId !== undefined) {
      employee.reportingManagerId = req.body.reportingManagerId || null;
    }
    if (req.body.designationId !== undefined) employee.designationId = req.body.designationId || null;
    if (req.body.employeeCode !== undefined && req.body.employeeCode.trim()) {
      employee.employeeCode = req.body.employeeCode.trim().toUpperCase();
    }
    if (req.body.dateOfBirth !== undefined) {
      employee.dateOfBirth = req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null;
    }
    if (req.body.dateOfJoining !== undefined) {
      employee.dateOfJoining = req.body.dateOfJoining ? new Date(req.body.dateOfJoining) : null;
    }
    if (req.body.probationEndDate !== undefined) {
      employee.probationEndDate = req.body.probationEndDate ? new Date(req.body.probationEndDate) : null;
    }
    if (req.body.employmentStatus !== undefined) {
      employee.employmentStatus = req.body.employmentStatus;
    }
    if (req.body.emergencyContact !== undefined) {
      employee.emergencyContact = {
        name: req.body.emergencyContact?.name || '',
        relation: req.body.emergencyContact?.relation || '',
        phone: req.body.emergencyContact?.phone || '',
      };
    }
    if (req.body.currentGrade !== undefined) {
      employee.currentGrade = String(req.body.currentGrade).toUpperCase();
    }
    if (req.body.overtimeRate !== undefined) {
      employee.overtimeRate = Number(req.body.overtimeRate) || 0;
    }
    if (req.body.statutoryApplicability !== undefined) {
      employee.statutoryApplicability = {
        epf: Boolean(req.body.statutoryApplicability?.epf),
        esi: Boolean(req.body.statutoryApplicability?.esi),
        uan: req.body.statutoryApplicability?.uan || '',
        esiNumber: req.body.statutoryApplicability?.esiNumber || '',
      };
    }
    if (req.body.timeboxEmployeeId !== undefined) {
      employee.timeboxEmployeeId = req.body.timeboxEmployeeId != null && req.body.timeboxEmployeeId !== ''
        ? Number(req.body.timeboxEmployeeId)
        : null;
    }
    if (req.body.timeboxName !== undefined) {
      employee.timeboxName = req.body.timeboxName ? String(req.body.timeboxName).trim() : '';
    }

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

export const linkTimeboxAccount = async (req, res) => {
  try {
    const { timeboxEmployeeId, timeboxName } = req.body;
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const tbId = timeboxEmployeeId != null && timeboxEmployeeId !== ''
      ? Number(timeboxEmployeeId)
      : null;

    if (tbId != null) {
      // Check if another employee already has this timebox ID
      const existing = await Employee.findOne({ timeboxEmployeeId: tbId, _id: { $ne: employee._id } });
      if (existing) {
        return res.status(400).json({
          message: `Timebox ID #${tbId} is already linked to ${existing.name} (${existing.employeeCode || existing._id})`
        });
      }
    }

    employee.timeboxEmployeeId = tbId;
    employee.timeboxName = timeboxName ? String(timeboxName).trim() : (tbId ? employee.name : '');
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

// @desc   Flat org directory for the hierarchy view — just the fields the client
//         needs to assemble the reporting tree (manager → reports) and group by
//         department. Kept separate from getEmployees so it stays light.
// @route  GET /api/employees/org-tree
// @access Private
export const getOrgTree = async (req, res) => {
  try {
    const [employees, activeDepts] = await Promise.all([
      Employee.find({})
        .select('name email phone status department departmentId reportingManagerId designationId role designation profileImage')
        .populate('departmentId', 'name')
        .populate('designationId', 'name level')
        .sort({ name: 1 })
        .lean(),
      Department.find({ active: true, head: { $ne: null } })
        .select('name head')
        .lean(),
    ]);

    const headMap = new Map();
    for (const d of activeDepts) {
      if (d.head) headMap.set(String(d.head), d.name);
    }

    const directReportsCountMap = new Map();
    for (const e of employees) {
      if (e.reportingManagerId) {
        const mgrId = String(e.reportingManagerId);
        directReportsCountMap.set(mgrId, (directReportsCountMap.get(mgrId) || 0) + 1);
      }
    }

    const nodes = employees.map((e) => {
      const fallbackRole = e.designation || e.role || '';
      const fallbackLevel = (() => {
        const r = fallbackRole.toLowerCase();
        if (r.includes('ceo') || r.includes('director') || r.includes('founder') || r.includes('deputy manager') || r.includes('c t o') || r.includes('cto')) return 5;
        if (r.includes('lead') || r.includes('head') || r.includes('manager')) return 4;
        if (r.includes('senior') || r.includes('dop') || r.includes('coordinator') || r.includes('fullstack') || r.includes('ai developer')) return 3;
        return 2;
      })();

      const reportsCount = directReportsCountMap.get(String(e._id)) || 0;
      const isDeptHead = headMap.has(String(e._id));

      return {
        id: String(e._id),
        name: e.name || '',
        email: e.email || '',
        phone: e.phone || '',
        status: e.status || 'active',
        department: e.departmentId?.name || e.department || '',
        departmentId: e.departmentId?._id ? String(e.departmentId._id) : null,
        designation: e.designationId?.name || fallbackRole,
        designationId: e.designationId?._id ? String(e.designationId._id) : null,
        designationLevel: e.designationId?.level ?? fallbackLevel,
        reportingManagerId: e.reportingManagerId ? String(e.reportingManagerId) : null,
        profileImage: e.profileImage || '',
        isDepartmentHead: isDeptHead,
        headOfDepartment: headMap.get(String(e._id)) || null,
        isTeamHead: isDeptHead || reportsCount > 0,
        directReportsCount: reportsCount,
      };
    });
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc   Set an employee's reporting manager (and optionally designation),
//         building the org hierarchy. Guards against reporting loops.
// @route  PUT /api/employees/:id/reporting   { reportingManagerId, designationId }
// @access Private
export const setReportingDetails = async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (req.body.reportingManagerId !== undefined) {
      const mgrId = req.body.reportingManagerId || null;
      if (mgrId && String(mgrId) === String(employee._id)) {
        return res.status(400).json({ message: 'An employee cannot report to themselves' });
      }
      if (mgrId) {
        // Walk up from the proposed manager; if we reach this employee, the
        // assignment would create a reporting loop.
        let cursor = await Employee.findById(mgrId).select('reportingManagerId');
        let hops = 0;
        while (cursor && cursor.reportingManagerId && hops < 200) {
          if (String(cursor.reportingManagerId) === String(employee._id)) {
            return res.status(400).json({ message: 'That reporting line would create a loop' });
          }
          cursor = await Employee.findById(cursor.reportingManagerId).select('reportingManagerId');
          hops += 1;
        }
      }
      employee.reportingManagerId = mgrId;
    }

    if (req.body.designationId !== undefined) {
      employee.designationId = req.body.designationId || null;
    }

    await employee.save();
    res.json({
      id: String(employee._id),
      reportingManagerId: employee.reportingManagerId ? String(employee.reportingManagerId) : null,
      designationId: employee.designationId ? String(employee.designationId) : null,
    });
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
    // Validate before writing anything so a bad value can't leave an
    // increment record without the matching salary change.
    if (newSalary == null || newSalary === '' || !Number.isFinite(Number(newSalary)) || Number(newSalary) < 0) {
      return res.status(400).json({ message: 'Please enter a valid new salary.' });
    }
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
