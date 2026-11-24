import User from '../models/User.js';
import Employee from '../models/Employee.js';
import { isLeadershipRole, leadershipTitle } from './leadership.js';

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

  // The company's leaders: the Management department, with their own title.
  if (isLeadershipRole(slug)) {
    return {
      category: 'administrative',
      department: 'Management',
      artistRole: 'staff',
      role: customTitle || leadershipTitle(slug),
      specialization: 'Leadership',
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

const isBlankDept = (d) => !String(d || '').trim() || String(d).trim() === 'Staff';

/**
 * Synchronizes a User record with a corresponding Employee record.
 *
 * HR owns the employee record (owner decision 2026-11-24). For an EXISTING
 * employee this never overwrites department, departmentId or category set by
 * HR. It only:
 *  - fills department / category / role / specialization when they are blank;
 *  - keeps the login's driver / artist role working (artistRole + operations
 *    category), because driver and artist screens depend on it;
 *  - (explicit calls only, i.e. an admin creating / editing / provisioning a
 *    login) copies the login name and active flag. An exited employee is never
 *    re-activated.
 * `{ boot: true }` (the startup migration) changes nothing else: no name and no
 * status, so a restart can't undo HR's edits.
 */
export const syncUserToEmployee = async (user, { boot = false } = {}) => {
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
    // A driver / artist login must stay a driver / artist employee (driver and
    // artist screens depend on artistRole); department is left to HR.
    if (mapping.artistRole === 'driver' || employee.artistRole === 'driver') {
      employee.category = 'operations';
      employee.artistRole = 'driver';
    } else if (mapping.artistRole === 'artist' || employee.artistRole === 'artist' || employee.artistRole === 'assistant') {
      employee.category = 'operations';
      if (employee.artistRole !== 'assistant') employee.artistRole = 'artist';
    } else if (!employee.category) {
      employee.category = mapping.category;
    }
    // Fill blanks only — never replace what HR set.
    if (isBlankDept(employee.department) && !employee.departmentId) employee.department = mapping.department;
    if (!employee.role || employee.role === 'Staff' || employee.role === 'MUA') {
      employee.role = mapping.role;
    }
    if (!employee.specialization || employee.specialization === 'Staff') {
      employee.specialization = mapping.specialization;
    }

    if (!boot) {
      employee.name = user.name || employee.name;
      const exited = employee.employmentStatus === 'exited';
      employee.status = user.active && !exited ? 'active' : 'inactive';
    } else if (!employee.name) {
      employee.name = user.name || employee.name;
    }
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
      let roleUpdated = false;
      const roleLower = String(user.role || '').toLowerCase();
      if (
        (roleLower.endsWith('manager') ||
         roleLower.endsWith('admin') ||
         roleLower === 'inventory_manager' ||
         roleLower === 'marketing_admin') &&
        !user.isDepartmentHead
      ) {
        user.isDepartmentHead = true;
        roleUpdated = true;
      }
      await syncUserToEmployee(user, { boot: true });
      if (roleUpdated) {
        await user.save();
      }
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

    // Only what driver / artist features need (artistRole + category), and a
    // department only when it is blank. HR's department and titles are kept.
    if (isDriver) {
      if (emp.category !== 'operations' || emp.artistRole !== 'driver') {
        emp.category = 'operations';
        emp.artistRole = 'driver';
        updated = true;
      }
      if (isBlankDept(emp.department) && !emp.departmentId) {
        emp.department = 'Operations';
        updated = true;
      }
    } else if (emp.artistRole === 'artist' || emp.artistRole === 'assistant' || emp.category === 'creative') {
      if (emp.category !== 'operations') {
        emp.category = 'operations';
        updated = true;
      }
      if (isBlankDept(emp.department) && !emp.departmentId) {
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
