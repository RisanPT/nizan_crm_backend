import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { timeboxFetch } from '../services/timeboxClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function run() {
  const empRes = await timeboxFetch('employees');
  const tbEmployees = empRes.data;
  
  const depts = new Set();
  const roles = new Set();
  tbEmployees.forEach(tb => {
     if (tb.department) depts.add(tb.department);
     if (tb.designation) roles.add(tb.designation);
     if (tb.role) roles.add(tb.role);
     console.log(`${tb.full_name}: Dept=${tb.department}, Desig=${tb.designation}, Role=${tb.role}`);
  });
  console.log('Departments:', Array.from(depts));
  console.log('Roles/Designations:', Array.from(roles));
}
run();
