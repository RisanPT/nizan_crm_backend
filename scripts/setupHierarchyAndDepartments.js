import mongoose from 'mongoose';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import Department, { SEED_DEPARTMENTS } from '../models/Department.js';
import Designation from '../models/Designation.js';
import Employee from '../models/Employee.js';

const DESIG_SEEDS = [
  // Board & Management (L5, L4)
  { name: 'Chief Executive Officer (CEO)', level: 5, deptKey: 'management' },
  { name: 'Deputy Manager', level: 5, deptKey: 'management' },
  { name: 'Administrator', level: 5, deptKey: 'management' },
  { name: 'PA to Management', level: 4, deptKey: 'management' },

  // IT (L4, L3, L2)
  { name: 'IT Team Lead', level: 4, deptKey: 'it' },
  { name: 'Project Head', level: 4, deptKey: 'it' },
  { name: 'Senior Dev-ops Engineer', level: 3, deptKey: 'it' },
  { name: 'Fullstack Developer', level: 3, deptKey: 'it' },
  { name: 'AI Developer', level: 3, deptKey: 'it' },
  { name: 'Developer', level: 2, deptKey: 'it' },
  { name: 'IT Administrator', level: 2, deptKey: 'it' },
  { name: 'Inventory Manager', level: 2, deptKey: 'it' },

  // HR (L4, L3, L2, L1)
  { name: 'HR Head', level: 4, deptKey: 'hr' },
  { name: 'Executive Coordinator', level: 3, deptKey: 'hr' },
  { name: 'HR Executive', level: 2, deptKey: 'hr' },
  { name: 'HR Intern', level: 1, deptKey: 'hr' },

  // Accounts & Finance (L4, L2)
  { name: 'Finance Manager', level: 4, deptKey: 'finance' },
  { name: 'Finance Head', level: 4, deptKey: 'accounts' },
  { name: 'Finance Executive', level: 2, deptKey: 'finance' },
  { name: 'Accounts Executive', level: 2, deptKey: 'accounts' },

  // Sales (L4, L2)
  { name: 'Sales Head', level: 4, deptKey: 'sales' },
  { name: 'Sales Executive', level: 2, deptKey: 'sales' },
  { name: 'Sales Staff', level: 2, deptKey: 'sales' },
  { name: 'Tele Caller', level: 2, deptKey: 'sales' },

  // Marketing (L4, L3, L2)
  { name: 'Marketing Manager', level: 4, deptKey: 'marketing' },
  { name: 'Director of Photography (DOP)', level: 3, deptKey: 'marketing' },
  { name: 'Digital Marketing Executive', level: 2, deptKey: 'marketing' },
  { name: 'Video Editor', level: 2, deptKey: 'marketing' },
  { name: 'Editor cum Videographer', level: 2, deptKey: 'marketing' },

  // CRM (L4, L2)
  { name: 'Customer Support Manager', level: 4, deptKey: 'crm' },
  { name: 'CRM Specialist', level: 2, deptKey: 'crm' },
  { name: 'Customer Relationship Associate (CRA)', level: 2, deptKey: 'crm' },

  // Operations & Fleet (L4, L3, L2, L1)
  { name: 'Fleet Manager', level: 4, deptKey: 'operations' },
  { name: 'Stylist Lead', level: 4, deptKey: 'operations' },
  { name: 'Stylist', level: 3, deptKey: 'operations' },
  { name: 'Makeup Artist (MUA)', level: 2, deptKey: 'operations' },
  { name: 'Hair and Saree Stylist', level: 2, deptKey: 'operations' },
  { name: 'Artist', level: 2, deptKey: 'operations' },
  { name: 'Fleet Driver', level: 2, deptKey: 'operations' },
  { name: 'Driver', level: 2, deptKey: 'operations' },
  { name: 'Staff', level: 1, deptKey: 'operations' },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  // 1. Ensure SEED_DEPARTMENTS exist
  const deptMap = new Map();
  for (const s of SEED_DEPARTMENTS) {
    let dept = await Department.findOne({
      $or: [{ key: s.key }, { name: s.name }]
    });

    if (!dept) {
      dept = await Department.create({ ...s, isSystem: true, active: true });
      console.log(`Created department: ${s.name} (${s.key})`);
    } else {
      dept.name = s.name;
      dept.division = s.division;
      dept.active = true;
      await dept.save();
    }
    deptMap.set(s.key, dept);
    deptMap.set(s.name.toLowerCase(), dept);
  }

  // Also handle alias 'it'
  const itDept = deptMap.get('it');
  if (itDept) deptMap.set('technology & systems (it)', itDept);

  // 2. Ensure Designations exist
  const desigMap = new Map();
  for (const ds of DESIG_SEEDS) {
    let desig = await Designation.findOne({ name: ds.name });
    const targetDept = deptMap.get(ds.deptKey);

    if (!desig) {
      desig = await Designation.create({
        name: ds.name,
        level: ds.level,
        departmentId: targetDept ? targetDept._id : null,
        active: true,
      });
      console.log(`Created designation: ${ds.name} (L${ds.level})`);
    } else {
      desig.level = ds.level;
      if (targetDept && !desig.departmentId) {
        desig.departmentId = targetDept._id;
      }
      await desig.save();
    }
    desigMap.set(ds.name.toLowerCase(), desig);
  }

  // Helper to resolve designation
  function findBestDesig(roleStr) {
    const r = (roleStr || '').toLowerCase().trim();
    if (!r) return null;
    if (r.includes('ceo')) return desigMap.get('chief executive officer (ceo)');
    if (r.includes('deputy manager')) return desigMap.get('deputy manager');
    if (r.includes('administrator') || r.includes('admin')) return desigMap.get('administrator');
    if (r.includes('pa')) return desigMap.get('pa to management');
    if (r.includes('team lead')) return desigMap.get('it team lead');
    if (r.includes('project head')) return desigMap.get('project head');
    if (r.includes('dev-ops')) return desigMap.get('senior dev-ops engineer');
    if (r.includes('fullstack')) return desigMap.get('fullstack developer');
    if (r.includes('ai developer')) return desigMap.get('ai developer');
    if (r.includes('developer')) return desigMap.get('developer');
    if (r.includes('inventory')) return desigMap.get('inventory manager');
    if (r.includes('hr') && (r.includes('head') || r === 'hr')) return desigMap.get('hr head');
    if (r.includes('coordinator')) return desigMap.get('executive coordinator');
    if (r.includes('hr executive')) return desigMap.get('hr executive');
    if (r.includes('intern')) return desigMap.get('hr intern');
    if (r.includes('finance manager')) return desigMap.get('finance manager');
    if (r.includes('finance head')) return desigMap.get('finance head');
    if (r.includes('finance executive')) return desigMap.get('finance executive');
    if (r.includes('accounts')) return desigMap.get('accounts executive');
    if (r.includes('sales head') || r.includes('sales manager')) return desigMap.get('sales head');
    if (r.includes('sales executive')) return desigMap.get('sales executive');
    if (r.includes('tele caller')) return desigMap.get('tele caller');
    if (r.includes('sales staff')) return desigMap.get('sales staff');
    if (r.includes('marketing manager')) return desigMap.get('marketing manager');
    if (r.includes('dop')) return desigMap.get('director of photography (dop)');
    if (r.includes('video editor')) return desigMap.get('video editor');
    if (r.includes('videographer')) return desigMap.get('editor cum videographer');
    if (r.includes('dm executive') || r.includes('digital marketing')) return desigMap.get('digital marketing executive');
    if (r.includes('customer support manager') || (r.includes('crm') && r.includes('manager'))) return desigMap.get('customer support manager');
    if (r.includes('cra')) return desigMap.get('customer relationship associate (cra)');
    if (r.includes('crm specialist')) return desigMap.get('crm specialist');
    if (r.includes('fleet manager')) return desigMap.get('fleet manager');
    if (r.includes('stylist')) return desigMap.get('stylist');
    if (r.includes('mua') || r.includes('makeup')) return desigMap.get('makeup artist (mua)');
    if (r.includes('hair') || r.includes('saree')) return desigMap.get('hair and saree stylist');
    if (r.includes('fleet driver')) return desigMap.get('fleet driver');
    if (r.includes('driver')) return desigMap.get('driver');
    if (r.includes('artist')) return desigMap.get('artist');
    return desigMap.get('staff');
  }

  // 3. Normalize General and Staff Departments
  console.log('Normalizing departments and designations...');

  // Specific General relocations:
  const generalFixes = [
    { name: /jasim/i, dept: 'Management', role: 'CEO' },
    { name: /ajmal/i, dept: 'Management', role: 'Deputy Manager' },
    { name: /swalih/i, dept: 'Management', role: 'PA to Management' },
    { name: /nizan/i, dept: 'Management', role: 'Administrator' },
    { name: /ashiq/i, dept: 'Marketing', role: 'Video Editor' },
    { name: /aysha mehna/i, dept: 'Marketing', role: 'Digital Marketing Executive' },
    { name: /alfiya ns/i, dept: 'Sales', role: 'Sales Executive' },
    { name: /aswani a\.e/i, dept: 'Operations', role: 'Hair and Saree Stylist' },
    { name: /amna/i, dept: 'HR', role: 'Executive Coordinator' },
    { name: /preethy babu/i, dept: 'Operations', role: 'Stylist Lead' },
    { name: /veena/i, dept: 'Sales', role: 'Tele Caller' },
    { name: /test/i, dept: 'Management', role: 'Executive Coordinator' },
  ];

  for (const fix of generalFixes) {
    const emp = await Employee.findOne({ name: fix.name });
    if (emp) {
      emp.department = fix.dept;
      if (fix.role) emp.role = fix.role;
      const targetDept = deptMap.get(fix.dept.toLowerCase());
      if (targetDept) emp.departmentId = targetDept._id;
      const desig = findBestDesig(emp.role);
      if (desig) emp.designationId = desig._id;
      await emp.save();
      console.log(`Updated General employee: ${emp.name} -> ${fix.dept} (${emp.role})`);
    }
  }

  // Update remaining employees with departmentId and designationId
  const allEmployees = await Employee.find({});
  for (const emp of allEmployees) {
    let deptName = emp.department || 'Operations';
    if (deptName === 'General') deptName = 'Operations';

    const targetDept = deptMap.get(deptName.toLowerCase()) || deptMap.get('operations');
    if (targetDept && (!emp.departmentId || String(emp.departmentId) !== String(targetDept._id))) {
      emp.departmentId = targetDept._id;
      emp.department = targetDept.name;
    }

    if (!emp.designationId) {
      const desig = findBestDesig(emp.role);
      if (desig) emp.designationId = desig._id;
    }
    await emp.save();
  }

  // 4. Resolve Key Leaders & Department Heads
  const jasim = await Employee.findOne({ name: /jasim/i });
  const ajmal = await Employee.findOne({ name: /ajmal/i });
  const swalih = await Employee.findOne({ name: /swalih/i });
  const nizan = await Employee.findOne({ name: /nizan/i });

  const shuhaibIt = await Employee.findOne({ name: /shuhaib/i, department: 'IT' });
  const risanIt = await Employee.findOne({ name: /risan/i, department: 'IT' });
  const nihalaHr = await Employee.findOne({ name: /nihala/i, department: 'HR' });
  const teebaFin = await Employee.findOne({ name: /teeba/i });
  const amruthaAcc = await Employee.findOne({ name: /amrutha/i });
  const saranyaCrm = await Employee.findOne({ name: /saranya/i, department: 'CRM' });
  const adithyaSales = await Employee.findOne({ name: /adithya/i });
  const salmanMkt = await Employee.findOne({ name: /salmanul faris/i });
  const preethyOps = await Employee.findOne({ name: /preethy babu/i });
  const adnanFleet = await Employee.findOne({ name: /adnan/i, role: /fleet/i });

  console.log('\nKey Leaders Identified:');
  console.log('CEO (Jasim):', jasim?._id, jasim?.name);
  console.log('Deputy Manager (Ajmal):', ajmal?._id, ajmal?.name);
  console.log('IT Head (Shuhaib):', shuhaibIt?._id, shuhaibIt?.name);
  console.log('HR Head (Nihala):', nihalaHr?._id, nihalaHr?.name);
  console.log('Finance Head (Teeba):', teebaFin?._id, teebaFin?.name);
  console.log('Accounts Head (Amrutha):', amruthaAcc?._id, amruthaAcc?.name);
  console.log('CRM Head (Saranya):', saranyaCrm?._id, saranyaCrm?.name);
  console.log('Sales Head (Adithya):', adithyaSales?._id, adithyaSales?.name);
  console.log('Marketing Head (Salmanul Faris):', salmanMkt?._id, salmanMkt?.name);
  console.log('Operations Stylist Lead (Preethy):', preethyOps?._id, preethyOps?.name);
  console.log('Fleet Lead (Adnan):', adnanFleet?._id, adnanFleet?.name);

  // 5. Update Department head references in Department collection
  const deptHeadAssignments = [
    { key: 'management', head: jasim },
    { key: 'it', head: shuhaibIt },
    { key: 'hr', head: nihalaHr },
    { key: 'finance', head: teebaFin },
    { key: 'accounts', head: amruthaAcc },
    { key: 'crm', head: saranyaCrm },
    { key: 'sales', head: adithyaSales },
    { key: 'marketing', head: salmanMkt },
    { key: 'operations', head: preethyOps },
    { key: 'fleet', head: adnanFleet },
  ];

  for (const dha of deptHeadAssignments) {
    const d = deptMap.get(dha.key);
    if (d && dha.head) {
      d.head = dha.head._id;
      await d.save();
      console.log(`Set Department head: ${d.name} -> ${dha.head.name}`);
    }
  }

  // 6. Establish Hierarchy (reportingManagerId)
  if (!jasim) {
    console.error('Cannot proceed without Jasim (Apex CEO)');
    await mongoose.disconnect();
    return;
  }

  // Apex (Jasim has no manager)
  jasim.reportingManagerId = null;
  await jasim.save();

  // Board members report to Jasim
  if (ajmal) { ajmal.reportingManagerId = jasim._id; await ajmal.save(); }
  if (swalih) { swalih.reportingManagerId = jasim._id; await swalih.save(); }
  if (nizan) { nizan.reportingManagerId = jasim._id; await nizan.save(); }

  // Department Heads report to Board:
  // IT, HR, Finance, CRM -> Jasim
  if (shuhaibIt) { shuhaibIt.reportingManagerId = jasim._id; await shuhaibIt.save(); }
  if (nihalaHr) { nihalaHr.reportingManagerId = jasim._id; await nihalaHr.save(); }
  if (teebaFin) { teebaFin.reportingManagerId = jasim._id; await teebaFin.save(); }
  if (saranyaCrm) { saranyaCrm.reportingManagerId = jasim._id; await saranyaCrm.save(); }

  // Sales, Marketing, Operations/Fleet -> Ajmal (or Jasim if Ajmal not found)
  const execSecond = ajmal ? ajmal._id : jasim._id;
  if (adithyaSales) { adithyaSales.reportingManagerId = execSecond; await adithyaSales.save(); }
  if (salmanMkt) { salmanMkt.reportingManagerId = execSecond; await salmanMkt.save(); }
  if (preethyOps) { preethyOps.reportingManagerId = execSecond; await preethyOps.save(); }
  if (adnanFleet) { adnanFleet.reportingManagerId = execSecond; await adnanFleet.save(); }

  // Department Staff:
  // IT:
  if (risanIt && shuhaibIt) { risanIt.reportingManagerId = shuhaibIt._id; await risanIt.save(); }
  const itStaff = await Employee.find({ department: 'IT', _id: { $nin: [shuhaibIt?._id, risanIt?._id] } });
  for (const s of itStaff) {
    // Developers report to Risan (Project Head) or Shuhaib
    s.reportingManagerId = risanIt ? risanIt._id : shuhaibIt._id;
    await s.save();
  }

  // HR:
  if (nihalaHr) {
    await Employee.updateMany(
      { department: 'HR', _id: { $ne: nihalaHr._id } },
      { $set: { reportingManagerId: nihalaHr._id } }
    );
  }

  // Finance & Accounts:
  if (teebaFin) {
    if (amruthaAcc) { amruthaAcc.reportingManagerId = teebaFin._id; await amruthaAcc.save(); }
    await Employee.updateMany(
      { department: { $in: ['Accounts', 'Finance'] }, _id: { $nin: [teebaFin._id, amruthaAcc?._id].filter(Boolean) } },
      { $set: { reportingManagerId: teebaFin._id } }
    );
  }

  // Sales:
  if (adithyaSales) {
    await Employee.updateMany(
      { department: 'Sales', _id: { $ne: adithyaSales._id } },
      { $set: { reportingManagerId: adithyaSales._id } }
    );
  }

  // Marketing:
  if (salmanMkt) {
    await Employee.updateMany(
      { department: 'Marketing', _id: { $ne: salmanMkt._id } },
      { $set: { reportingManagerId: salmanMkt._id } }
    );
  }

  // CRM:
  if (saranyaCrm) {
    await Employee.updateMany(
      { department: 'CRM', _id: { $ne: saranyaCrm._id } },
      { $set: { reportingManagerId: saranyaCrm._id } }
    );
  }

  // Operations:
  // Drivers report to Adnan (Fleet Lead)
  if (adnanFleet) {
    await Employee.updateMany(
      { department: 'Operations', role: /driver/i, _id: { $ne: adnanFleet._id } },
      { $set: { reportingManagerId: adnanFleet._id } }
    );
  }
  // Creative Artists & Stylists report to Preethy Babu
  if (preethyOps) {
    await Employee.updateMany(
      {
        department: 'Operations',
        role: { $not: /driver/i },
        _id: { $nin: [preethyOps._id, adnanFleet?._id].filter(Boolean) }
      },
      { $set: { reportingManagerId: preethyOps._id } }
    );
  }

  console.log('\nHierarchy configuration successfully completed!');

  // Print summary check
  const rootCount = await Employee.countDocuments({ reportingManagerId: null });
  const withManagerCount = await Employee.countDocuments({ reportingManagerId: { $ne: null } });
  console.log(`Root employees (no manager): ${rootCount}`);
  console.log(`Employees with manager: ${withManagerCount}`);

  const roots = await Employee.find({ reportingManagerId: null }).select('name department role');
  console.log('Roots:', roots);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
