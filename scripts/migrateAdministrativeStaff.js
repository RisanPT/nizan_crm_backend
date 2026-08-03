import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { migrateAndSyncAll } from '../utils/syncUserEmployee.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';

async function run() {
  try {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      console.error('MONGO_URI is not set. Aborting.');
      process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected to MongoDB.\n');

    await migrateAndSyncAll();

    // Summary output
    const adminEmployees = await Employee.find({ category: 'administrative' }).lean();
    const opsEmployees = await Employee.find({ category: 'operations' }).lean();

    console.log('\n===========================================');
    console.log(`📊 ADMINISTRATIVE STAFF (${adminEmployees.length}):`);
    for (const e of adminEmployees) {
      console.log(`  - [${e.department}] ${e.name} (${e.role || 'Staff'}) | Email: ${e.email || 'None'}`);
    }

    console.log(`\n🚗 OPERATIONS STAFF (${opsEmployees.length}):`);
    for (const e of opsEmployees) {
      console.log(`  - [${e.artistRole}] ${e.name} (${e.role || e.specialization})`);
    }
    console.log('===========================================\n');

    await mongoose.disconnect();
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
