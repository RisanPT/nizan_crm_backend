import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import connectDB from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
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
import expenseRoutes from './routes/expenseRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import itTaskRoutes from './routes/itTaskRoutes.js';
import timeBlockRoutes from './routes/timeBlockRoutes.js';
import budgetRoutes from './routes/budgetRoutes.js';
import { seedAdminUser } from './utils/seedAdminUser.js';

import fleetRoutes from './routes/fleetRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import trialRoutes from './routes/trialRoutes.js';

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
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/leads', leadRoutes);
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
app.use('/api/expenses', expenseRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/it-tasks', itTaskRoutes);
app.use('/api/time-blocks', timeBlockRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/trials', trialRoutes);

app.get('/api', (req, res) => {
  res.json({ message: 'API is running...' });
});

app.get('/', (req, res) => {
  res.send('API is running...');
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  if (
    process.env.MONGO_URI &&
    process.env.MONGO_URI !== 'your_mongodb_connection_string_here'
  ) {
    await connectDB();
    await seedAdminUser();
  } else {
    console.log(
      'MongoDB connection skipped: Please provide a valid MONGO_URI in the .env file'
    );
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
};

startServer();
