import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

import User from './models/User.js';
import Employee from './models/Employee.js';
import Role from './models/Role.js';

async function inspect() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('--- CONNECTED TO MONGODB ---');

    const users = await User.find({}).lean();
    console.log(`\n=== USERS COUNT: ${users.length} ===`);
    const usersByRole = {};
    for (const u of users) {
      usersByRole[u.role] = (usersByRole[u.role] || 0) + 1;
      console.log(`User: ${u.name} | email: ${u.email} | role: ${u.role} | employeeId: ${u.employeeId} | active: ${u.active}`);
    }
    console.log('Users by role:', usersByRole);

    const employees = await Employee.find({}).lean();
    console.log(`\n=== EMPLOYEES COUNT: ${employees.length} ===`);
    const empByCategory = {};
    const empByDept = {};
    for (const e of employees) {
      empByCategory[e.category] = (empByCategory[e.category] || 0) + 1;
      empByDept[e.department] = (empByDept[e.department] || 0) + 1;
      console.log(`Employee: ${e.name} | email: ${e.email} | category: ${e.category} | dept: ${e.department} | role: ${e.role} | artistRole: ${e.artistRole} | spec: ${e.specialization}`);
    }
    console.log('Employees by category:', empByCategory);
    console.log('Employees by department:', empByDept);

    const roles = await Role.find({}).lean();
    console.log(`\n=== ROLES COUNT: ${roles.length} ===`);
    for (const r of roles) {
      console.log(`Role: ${r.key} | label: ${r.label} | isSystem: ${r.isSystem} | permissions: ${r.permissions.join(', ')}`);
    }

    await mongoose.disconnect();
    console.log('\n--- DISCONNECTED ---');
  } catch (err) {
    console.error('Error inspecting DB:', err);
    process.exit(1);
  }
}

inspect();
