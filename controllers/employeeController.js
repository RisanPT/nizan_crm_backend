import Employee from '../models/Employee.js';

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

// @desc    Get all employees
// @route   GET /api/employees
// @access  Public (for now)
export const getEmployees = async (req, res) => {
  try {
    const employees = await Employee.find({}).populate('regionId', 'name status');
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
  } = req.body;

  try {
    if (email) {
      const employeeExists = await Employee.findOne({ email });
      if (employeeExists) {
        return res.status(400).json({ message: 'Employee already exists' });
      }
    }

    const normalizedWorks = normalizeWorks(works, specialization);
    const normalizedSpecialization =
      normalizedWorks[0] ?? String(specialization ?? '').trim();

    const employee = await Employee.create({
      name,
      email: email ?? '',
      type: type ?? 'outsource',
      artistRole: artistRole ?? 'artist',
      specialization: normalizedSpecialization,
      works: normalizedWorks,
      phone: phone ?? '',
      status: status ?? 'active',
      regionId: regionId || null,
      role: normalizedSpecialization,
      department: 'Staff',
    });

    const populatedEmployee = await Employee.findById(employee._id).populate(
      'regionId',
      'name status'
    );

    res.status(201).json(populatedEmployee);
  } catch (error) {
    res.status(500).json({ message: error.message });
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
  } = req.body;

  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (email && email != employee.email) {
      const employeeExists = await Employee.findOne({ email });
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
    employee.email = email ?? employee.email;
    employee.type = type ?? employee.type;
    employee.artistRole = artistRole ?? employee.artistRole;
    employee.specialization = effectiveSpecialization;
    employee.works = normalizedWorks;
    employee.phone = phone ?? employee.phone;
    employee.status = status ?? employee.status;
    employee.regionId = regionId || null;
    employee.role = effectiveSpecialization || employee.role;
    employee.department = 'Staff';

    await employee.save();

    const populatedEmployee = await Employee.findById(employee._id).populate(
      'regionId',
      'name status'
    );

    res.json(populatedEmployee);
  } catch (error) {
    res.status(500).json({ message: error.message });
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
