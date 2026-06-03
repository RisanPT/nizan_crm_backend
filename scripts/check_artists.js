import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import Booking from '../models/Booking.js';

dotenv.config();

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('--- CONNECTED TO DB ---');

    const users = await User.find({ role: 'artist' }).lean();
    console.log('\nARTIST USERS IN DB:');
    users.forEach(u => {
      console.log(`User Name: ${u.name}, Email: ${u.email}, employeeId: ${u.employeeId}`);
    });

    const employees = await Employee.find({}).lean();
    console.log('\nEMPLOYEES IN DB:');
    employees.forEach(e => {
      console.log(`Employee Name: ${e.name}, ID: ${e._id}, Role: ${e.artistRole}`);
    });

    const bookings = await Booking.find({}).lean();
    console.log(`\nTOTAL BOOKINGS: ${bookings.length}`);
    
    // Count assignments
    const assignments = {};
    bookings.forEach(b => {
      (b.assignedStaff || []).forEach(s => {
        if (s.employeeId) {
          assignments[s.employeeId] = (assignments[s.employeeId] || 0) + 1;
        }
      });
      (b.bookingItems || []).forEach(item => {
        (item.assignedStaff || []).forEach(s => {
          if (s.employeeId) {
            assignments[s.employeeId] = (assignments[s.employeeId] || 0) + 1;
          }
        });
      });
    });

    console.log('\nBOOKING ASSIGNMENTS COUNT BY EMPLOYEE ID:');
    Object.entries(assignments).forEach(([empId, count]) => {
      const emp = employees.find(e => e._id.toString() === empId);
      console.log(`Employee Name: ${emp ? emp.name : 'Unknown'}, ID: ${empId}, Assigned Bookings: ${count}`);
    });

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

run();
