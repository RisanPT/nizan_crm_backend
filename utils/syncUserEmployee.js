import User from '../models/User.js';
import Employee from '../models/Employee.js';

/**
 * Maps a user role slug to appropriate Employee department, category, and display role.
 */
export const mapRoleToDepartmentAndCategory = (roleSlug, customTitle = '') => {
  const slug = String(roleSlug || '').trim().toLowerCase();

  if (slug === 'driver') {
    return {
      category: 'operations',
      department: 'Operations',
      artistRole: 'driver',
      role: customTitle || 'Fleet Driver',
      specialization: 'Fleet Driver',
    };
  }

  if (slug === 'artist') {
    return {
      category: 'operations',
      department: 'Operations',
      artistRole: 'artist',
      role: customTitle || 'MUA Artist',
      specialization: 'MUA Artist',
    };
  }

  // Administrative departments
  if (slug.includes('sales')) {
    let roleTitle = 'Sales Executive';
    if (slug.includes('manager')) roleTitle = 'Sales Manager';
    return {
      category: 'administrative',
      department: 'Sales',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'Sales',
    };
  }

  if (slug.includes('marketing')) {
    let roleTitle = 'Marketing Executive';
    if (slug.includes('admin') || slug.includes('manager')) roleTitle = 'Marketing Manager';
    return {
      category: 'administrative',
      department: 'Marketing',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'Marketing',
    };
  }

  if (slug.includes('account') || slug.includes('finance')) {
    let roleTitle = 'Accounts Executive';
    if (slug.includes('manager')) roleTitle = 'Accounts Manager';
    return {
      category: 'administrative',
      department: 'Accounts',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'Accounts & Finance',
    };
  }

  if (slug.includes('crm')) {
    let roleTitle = 'CRM Specialist';
    if (slug.includes('manager')) roleTitle = 'CRM Manager';
    return {
      category: 'administrative',
      department: 'CRM',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'CRM',
    };
  }

  if (slug.includes('it') || slug.includes('inventory')) {
    let roleTitle = slug.includes('inventory') ? 'Inventory Manager' : 'IT Administrator';
    return {
      category: 'administrative',
      department: 'IT',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'IT & Systems',
    };
  }

  if (slug.includes('hr')) {
    let roleTitle = 'HR Executive';
    if (slug.includes('manager')) roleTitle = 'HR Manager';
    return {
      category: 'administrative',
      department: 'HR',
      artistRole: 'staff',
      role: customTitle || roleTitle,
      specialization: 'Human Resources',
    };
  }

  if (slug.includes('fleet_manager') || slug.includes('fleet')) {
    return {
      category: 'administrative',
      department: 'Operations',
      artistRole: 'staff',
      role: customTitle || 'Fleet Manager',
      specialization: 'Fleet Operations',
    };
  }

  // Admin / General manager default
  let roleTitle = 'Manager';
  if (slug === 'admin') roleTitle = 'Administrator';
  return {
    category: 'administrative',
    department: 'General',
    artistRole: 'staff',
    role: customTitle || roleTitle,
    specialization: 'Administration',
  };
};

/**
 * Synchronizes a User record with a corresponding Employee record.
 */
export const syncUserToEmployee = async (user) => {
  if (!user || !user.email) return null;

  const email = user.email.trim().toLowerCase();
  const mapping = mapRoleToDepartmentAndCategory(user.role);

  // Find by employeeId or email
  let employee = null;
  if (user.employeeId) {
    employee = await Employee.findById(user.employeeId);
  }
  if (!employee) {
    employee = await Employee.findOne({ email });
  }

  if (employee) {
    // If it's a driver or artist, ensure operational category
    if (employee.artistRole === 'driver' || mapping.artistRole === 'driver') {
      employee.category = 'operations';
      employee.department = 'Operations';
      employee.artistRole = 'driver';
    } else if (employee.artistRole === 'artist' || employee.artistRole === 'assistant' || mapping.artistRole === 'artist') {
      employee.category = 'operations';
      employee.department = 'Operations';
    } else {
      employee.category = mapping.category;
      employee.department = mapping.department;
      employee.artistRole = mapping.artistRole;
      if (!employee.role || employee.role === 'Staff' || employee.role === 'MUA') {
        employee.role = mapping.role;
      }
      if (!employee.specialization || employee.specialization === 'Staff') {
        employee.specialization = mapping.specialization;
      }
    }

    employee.name = user.name || employee.name;
    employee.status = user.active ? 'active' : 'inactive';
    if (user.zoneId) employee.zoneId = user.zoneId;
    if (user.stateId) employee.stateId = user.stateId;
    if (user.regionId) employee.regionId = user.regionId;
    if (user.districtId) employee.districtId = user.districtId;
    if (user.pincodeId) employee.pincodeId = user.pincodeId;

    await employee.save();
  } else {
    // Create new employee
    employee = await Employee.create({
      name: user.name || email.split('@')[0],
      email,
      phone: '',
      type: 'in-house',
      category: mapping.category,
      department: mapping.department,
      artistRole: mapping.artistRole,
      role: mapping.role,
      specialization: mapping.specialization,
      works: [mapping.specialization],
      status: user.active ? 'active' : 'inactive',
      zoneId: user.zoneId || null,
      stateId: user.stateId || null,
      regionId: user.regionId || null,
      districtId: user.districtId || null,
      pincodeId: user.pincodeId || null,
    });
  }

  if (!user.employeeId || user.employeeId.toString() !== employee._id.toString()) {
    user.employeeId = employee._id;
    await user.save();
  }

  return employee;
};

/**
 * Full migration and synchronization of all Users and Employees.
 */
export const migrateAndSyncAll = async () => {
  console.log('🔄 [Staff Sync] Running user-employee migration & synchronization...');

  // 1. Sync all Users to Employees
  const users = await User.find({});
  let userCount = 0;
  for (const user of users) {
    try {
      await syncUserToEmployee(user);
      userCount++;
    } catch (err) {
      console.error(`Error syncing user ${user.email}:`, err.message);
    }
  }

  // 2. Clean up any remaining Employees (e.g. drivers/artists that were marked administrative or in 'Staff')
  const allEmployees = await Employee.find({});
  let cleanedCount = 0;
  for (const emp of allEmployees) {
    let updated = false;

    // Check if it's a driver
    const isDriver =
      emp.artistRole === 'driver' ||
      String(emp.role || '').toLowerCase().includes('driver') ||
      String(emp.specialization || '').toLowerCase().includes('driver');

    if (isDriver) {
      if (emp.category !== 'operations' || emp.department !== 'Operations' || emp.artistRole !== 'driver') {
        emp.category = 'operations';
        emp.department = 'Operations';
        emp.artistRole = 'driver';
        emp.role = 'Fleet Driver';
        emp.specialization = 'Fleet Driver';
        updated = true;
      }
    } else if (emp.artistRole === 'artist' || emp.artistRole === 'assistant' || emp.category === 'creative') {
      if (emp.category !== 'operations' || emp.department !== 'Operations') {
        emp.category = 'operations';
        emp.department = 'Operations';
        updated = true;
      }
    } else if (emp.category === 'administrative') {
      if (emp.department === 'Staff' || !emp.department) {
        // Guess department from role / specialization
        const mapping = mapRoleToDepartmentAndCategory(emp.role || emp.specialization);
        emp.department = mapping.department;
        updated = true;
      }
    }

    if (updated) {
      await emp.save();
      cleanedCount++;
    }
  }

  console.log(`✅ [Staff Sync] Completed: ${userCount} users synced, ${cleanedCount} employees normalized.`);
};
