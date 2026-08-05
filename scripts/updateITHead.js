import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Employee from '../models/Employee.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  // Find Shuhaib (he is IT dept head in Timebox)
  const emp = await Employee.findOne({ email: 'shuhaibnizan@gmail.com' });
  if (emp) {
    emp.specialization = 'IT Department Head';
    emp.role = 'IT Department Head';
    await emp.save();
    console.log('Updated Shuhaib to IT Department Head');
  } else {
    console.log('Could not find shuhaib');
  }
  process.exit(0);
}
run();
