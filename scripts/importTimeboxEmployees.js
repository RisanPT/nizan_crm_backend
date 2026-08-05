import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Employee from '../models/Employee.js';
import { timeboxFetch } from '../services/timeboxClient.js';
import { syncUserToEmployee } from '../utils/syncUserEmployee.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const empRes = await timeboxFetch('employees');
    const tbEmployees = empRes.data;

    let created = 0;
    let existingCount = 0;

    for (const tb of tbEmployees) {
      const tbId = Number(tb.id);
      const tbEmail = String(tb.email || '').trim().toLowerCase();
      const tbName = String(tb.full_name || tb.name || '').trim();
      const tbDepartment = String(tb.department || 'General');
      const tbDesignation = String(tb.designation || tb.role || 'Staff');
      
      // Try to find if exists
      let existing = await Employee.findOne({ timeboxEmployeeId: tbId });
      
      if (!existing && tbEmail) {
         existing = await Employee.findOne({ email: tbEmail });
      }
      
      if (!existing && tbName) {
         // Try case insensitive name match
         existing = await Employee.findOne({ name: new RegExp('^' + tbName + '$', 'i') });
      }

      if (existing) {
        existingCount++;
        // Sync timebox ID if missing
        if (!existing.timeboxEmployeeId) {
           existing.timeboxEmployeeId = tbId;
           existing.timeboxName = tbName;
           await existing.save();
        }
        continue;
      }

      console.log(`Creating missing employee: ${tbName} (${tbEmail})`);
      const newEmp = new Employee({
        name: tbName || 'Unknown Timebox Employee',
        email: tbEmail,
        type: 'full-time',
        artistRole: 'staff',
        specialization: tbDesignation,
        phone: tb.phone || '',
        status: tb.active === false ? 'inactive' : 'active',
        role: tbDesignation,
        department: tbDepartment,
        category: 'administrative', // default for HR imports usually
        salaryType: 'fixed_monthly',
        baseSalary: 0,
        timeboxEmployeeId: tbId,
        timeboxName: tbName,
      });

      await newEmp.save();
      created++;
      
      // Auto-sync User account if needed
      try {
        await syncUserToEmployee(newEmp);
      } catch (err) {
        console.error('User sync error for', tbName, err.message);
      }
    }

    console.log(`\nImport complete. Created: ${created}, Already Existed: ${existingCount}`);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

run();
