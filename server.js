import express from 'express';
// Must load before any route runs: forwards async handler errors to next().
import './utils/asyncErrors.js';
import {
  sanitizeErrorResponses,
  notFound,
  errorHandler,
} from './middleware/errorMiddleware.js';
import dotenv from 'dotenv';
import cors from 'cors';
import connectDB from './config/db.js';
import { ensureDefaultRoles } from './controllers/roleController.js';
import authRoutes from './routes/authRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import bookingRoutes from './routes/bookingRoutes.js';
import packageRoutes from './routes/packageRoutes.js';
import regionRoutes from './routes/regionRoutes.js';
import zoneRoutes from './routes/zoneRoutes.js';
import stateRoutes from './routes/stateRoutes.js';
import districtRoutes from './routes/districtRoutes.js';
import pincodeRoutes from './routes/pincodeRoutes.js';
import addonServiceRoutes from './routes/addonServiceRoutes.js';
import blockedDateRoutes from './routes/blockedDateRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import fuelExpenseRoutes from './routes/fuelExpenseRoutes.js';
import collectionRoutes from './routes/collectionRoutes.js';
import artistPayoutRoutes from './routes/artistPayoutRoutes.js';
import expenseRoutes from './routes/expenseRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import itTaskRoutes from './routes/itTaskRoutes.js';
import timeBlockRoutes from './routes/timeBlockRoutes.js';
import budgetRoutes from './routes/budgetRoutes.js';
import { seedAdminUser } from './utils/seedAdminUser.js';
import { migrateAndSyncAll } from './utils/syncUserEmployee.js';

import fleetRoutes from './routes/fleetRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import trialRoutes from './routes/trialRoutes.js';
import trialPackageRoutes from './routes/trialPackageRoutes.js';
import roleRoutes from './routes/roleRoutes.js';
import departmentRoutes from './routes/departmentRoutes.js';
import adminExpenseRoutes from './routes/adminExpenseRoutes.js';
import expenseCategoryRoutes from './routes/expenseCategoryRoutes.js';
import reviewRoutes from './routes/reviewRoutes.js';
import clientAuthRoutes from './routes/clientAuthRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import staffClientRoutes from './routes/staffClientRoutes.js';
import subscriptionRoutes from './routes/subscriptionRoutes.js';
import salaryRoutes from './routes/salaryRoutes.js';
import salesReturnRoutes from './routes/salesReturnRoutes.js';
import hrBridgeRoutes from './routes/hrBridgeRoutes.js';
import timeboxRoutes from './routes/timeboxRoutes.js';
import { performTimeboxEmployeeSync } from './controllers/timeboxController.js';
import performanceRoutes from './routes/performanceRoutes.js';
import hraRoutes from './routes/hraRoutes.js';
import accountReportRoutes from './routes/accountReportRoutes.js';
import assetRoutes from './routes/assetRoutes.js';
import accountingRoutes from './routes/accountingRoutes.js';
import taxFilingRoutes from './routes/taxFilingRoutes.js';
import salesReportRoutes from './routes/salesReportRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import salesTargetRoutes from './routes/salesTargetRoutes.js';
import goalRoutes from './routes/goalRoutes.js';
import slotRoutes from './routes/slotRoutes.js';
import bankAccountRoutes from './routes/bankAccountRoutes.js';
import cashTransactionRoutes from './routes/cashTransactionRoutes.js';
import bookingAdvanceRoutes from './routes/bookingAdvanceRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import helpRoutes from './routes/helpRoutes.js';
import geoRoutes from './routes/geoRoutes.js';
import companyReportRoutes from './routes/companyReportRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import contentRoutes from './routes/contentRoutes.js';
import backupRoutes from './routes/backupRoutes.js';
import okrRoutes from './routes/okrRoutes.js';
import projectDocRoutes from './routes/projectDocRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import approvalRoutes from './routes/approvalRoutes.js';
import designationRoutes from './routes/designationRoutes.js';
import employeeDocumentRoutes from './routes/employeeDocumentRoutes.js';
import shiftRoutes from './routes/shiftRoutes.js';
import timesheetRoutes from './routes/timesheetRoutes.js';
import regularizationRoutes from './routes/regularizationRoutes.js';
import recruitmentRoutes from './routes/recruitmentRoutes.js';
import onboardingRoutes from './routes/onboardingRoutes.js';
import offboardingRoutes from './routes/offboardingRoutes.js';
import reimbursementRoutes from './routes/reimbursementRoutes.js';
import travelRoutes from './routes/travelRoutes.js';
import compensationRoutes from './routes/compensationRoutes.js';
import engagementRoutes from './routes/engagementRoutes.js';
import letterRoutes from './routes/letterRoutes.js';
import lmsRoutes from './routes/lmsRoutes.js';
import grievanceRoutes from './routes/grievanceRoutes.js';
import hrAnalyticsRoutes from './routes/hrAnalyticsRoutes.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env'), override: true });

const app = express();

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:57903',
  'http://localhost:49705',
  'http://localhost:60815',
  'http://localhost:61883',
  'http://localhost:58037',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:57709',
  'http://127.0.0.1:60350',
  'http://127.0.0.1:61883',
  'http://192.168.31.205:5001',
  'http://18.178.214.176:5001',
  'https://teamnmakeovers.netlify.app',
  ...(process.env.FRONTEND_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

// Private LAN address (RFC1918) — lets a phone/device on the same Wi-Fi open the
// web build served from the dev machine's LAN IP without a CORS rejection.
function isPrivateLanHost(hostname) {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.has(origin)) {
    return true;
  }

  try {
    const { protocol, hostname } = new URL(origin);
    const isHttpOrigin = protocol === 'http:' || protocol === 'https:';

    if (!isHttpOrigin) {
      return false;
    }

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      isPrivateLanHost(hostname) ||
      hostname.endsWith('.netlify.app') ||
      hostname === 'teamnmakeovers.com' ||
      hostname.endsWith('.teamnmakeovers.com')
    ) {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

// Middleware
// First, so every error response (including CORS / JSON-parse failures) is
// humanised before it reaches the client.
app.use(sanitizeErrorResponses);
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.options('*', cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/attendances', attendanceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/zones', zoneRoutes);
app.use('/api/states', stateRoutes);
app.use('/api/districts', districtRoutes);
app.use('/api/pincodes', pincodeRoutes);
app.use('/api/addon-services', addonServiceRoutes);
app.use('/api/blocked-dates', blockedDateRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/fuel-expenses', fuelExpenseRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/artist-payouts', artistPayoutRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/it-tasks', itTaskRoutes);
app.use('/api/okrs', okrRoutes);
app.use('/api/project-docs', projectDocRoutes); // Versioned project documents (SRS, design, API specs)
app.use('/api/tickets', ticketRoutes);
app.use('/api/content', contentRoutes);          // Marketing content planning
app.use('/api/backup', backupRoutes);            // Per-department + full data backup
app.use('/api/time-blocks', timeBlockRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/trials', trialRoutes);
app.use('/api/trial-packages', trialPackageRoutes);
app.use('/api/admin-expenses', adminExpenseRoutes);
app.use('/api/expense-categories', expenseCategoryRoutes); // Per-department expense categories (CRUD)
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/salaries', salaryRoutes);
app.use('/api/sales-returns', salesReturnRoutes);
app.use('/api/hr', hrBridgeRoutes);               // PHP attendance bridge
app.use('/api/timebox', timeboxRoutes);           // Timebox attendance + payroll
app.use('/api/performance', performanceRoutes);   // HR 5-pillar evaluations
app.use('/api/hra', hraRoutes);                   // House Rent Allowance (separate from salary)
app.use('/api/leave', leaveRoutes);               // HR: leave types, requests, balances, holidays, comp-off
app.use('/api/approvals', approvalRoutes);        // HR: generic approvals inbox/engine
app.use('/api/designations', designationRoutes);  // HR: job titles / designations
app.use('/api/employee-documents', employeeDocumentRoutes); // HR: per-employee document vault (Files)
app.use('/api/shifts', shiftRoutes);              // HR: shifts + roster assignments
app.use('/api/timesheets', timesheetRoutes);      // HR: time tracker / timesheets
app.use('/api/regularizations', regularizationRoutes); // HR: attendance regularization
app.use('/api/recruitment', recruitmentRoutes);   // HR: job posts, candidates, offers
app.use('/api/onboarding', onboardingRoutes);     // HR: new-hire onboarding checklists
app.use('/api/offboarding', offboardingRoutes);   // HR: employee exit / clearance
app.use('/api/reimbursements', reimbursementRoutes); // HR: expense claims (→ ledger on pay)
app.use('/api/travel', travelRoutes);             // HR: travel requests
app.use('/api/compensation', compensationRoutes); // HR: salary bands + revisions
app.use('/api/engagement', engagementRoutes);     // HR: announcements / events feed
app.use('/api/letters', letterRoutes);            // HR: letter templates + generated letters
app.use('/api/lms', lmsRoutes);                   // HR: courses + enrolments (training)
app.use('/api/grievances', grievanceRoutes);      // HR: employee grievances
app.use('/api/hr-analytics', hrAnalyticsRoutes);  // HR: headcount / attrition dashboard
app.use('/api/account-reports', accountReportRoutes);
app.use('/api/assets', assetRoutes);              // Company asset register (Finance)
app.use('/api/accounting', accountingRoutes);     // Double-entry ledger (Finance)
app.use('/api/tax-filings', taxFilingRoutes);     // GST/TDS filing-status tracker
app.use('/api/sales-reports', salesReportRoutes); // Sales analytics reports
app.use('/api/dashboard', dashboardRoutes);         // Main dashboard analytics tabs
app.use('/api/sales-targets', salesTargetRoutes); // Monthly salesperson targets
app.use('/api/goals', goalRoutes); // Company day / week / month goals + day-wise report
app.use('/api/slots', slotRoutes);                // Day-wise booking slot capacity
app.use('/api/bank-accounts', bankAccountRoutes); // Manual bank balances (Finance)
app.use('/api/cash-transactions', cashTransactionRoutes); // Accounts' Cash In / Out / Transfer entries
app.use('/api/booking-advances', bookingAdvanceRoutes); // Accounts verifies booking advances
app.use('/api/help', helpRoutes);                     // In-app help bot (manual-grounded; no business data)
app.use('/api/whatsapp', whatsappRoutes);           // TeamN Chat: send quotation / invoice PDFs on WhatsApp
app.use('/api/geo', geoRoutes);                    // Road distance from HQ (OpenRouteService)
app.use('/api/company-reports', companyReportRoutes); // Per-department report library
app.use('/api/reviews', reviewRoutes);                // Post-service client review forms
app.use('/api/client/auth', clientAuthRoutes);        // Client app: phone-OTP / magic-link login (public)
app.use('/api/client', clientRoutes);                 // Client app: my-profile / my-bookings (protectClient)
app.use('/api/chat', chatRoutes);                     // Concierge chat (client + staff)
app.use('/api/app-clients', staffClientRoutes);       // Staff: view bridal app clients (brides)

app.get('/api', (req, res) => {
  res.json({ message: 'API is running...' });
});

app.get('/', (req, res) => {
  res.send('API is running...');
});

// Unknown API routes → JSON 404; then the global error handler (last).
app.use('/api', notFound);
app.use(errorHandler);

// A failed promise nobody awaited must not crash the server (Node >= 15
// exits on unhandled rejections). Log it so it can be fixed.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  if (
    process.env.MONGO_URI &&
    process.env.MONGO_URI !== 'your_mongodb_connection_string_here'
  ) {
    await connectDB();
    await ensureDefaultRoles(); // seed any new system roles (e.g. artist_head)
    await seedAdminUser();
    await migrateAndSyncAll();

    // Auto-sync Timebox employees on server boot
    performTimeboxEmployeeSync()
      .then((res) => console.log(`[Timebox] Auto-sync complete: ${res.message}`))
      .catch((err) => console.error('[Timebox] Boot sync failed:', err?.message || err));

    // Auto-sync Timebox employees periodically every 30 minutes
    const TIMEBOX_AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
    setInterval(() => {
      performTimeboxEmployeeSync()
        .then((res) => console.log(`[Timebox] Periodic sync: ${res.message}`))
        .catch((err) => console.error('[Timebox] Periodic sync failed:', err?.message || err));
    }, TIMEBOX_AUTO_SYNC_INTERVAL_MS);
  } else {
    console.log(
      'MongoDB connection skipped: Please provide a valid MONGO_URI in the .env file'
    );
  }

  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n⚠️  [Port In Use] Port ${PORT} is already in use by another running instance.`);
      console.error(`   The backend is already active on http://localhost:${PORT}`);
      console.error(`   If you need to restart, terminate the existing process on port ${PORT} first.\n`);
      process.exit(0);
    }
    throw err;
  });
};

startServer();

