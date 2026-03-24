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
import addonServiceRoutes from './routes/addonServiceRoutes.js';
import blockedDateRoutes from './routes/blockedDateRoutes.js';
import { seedAdminUser } from './utils/seedAdminUser.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
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
app.use('/api/addon-services', addonServiceRoutes);
app.use('/api/blocked-dates', blockedDateRoutes);

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

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
};

startServer();
