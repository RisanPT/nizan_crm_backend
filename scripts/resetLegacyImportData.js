import dotenv from 'dotenv';
import mongoose from 'mongoose';

import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';
import Employee from '../models/Employee.js';
import Region from '../models/Region.js';

dotenv.config();

const KERALA_DISTRICTS = [
  'Thiruvananthapuram',
  'Kollam',
  'Pathanamthitta',
  'Alappuzha',
  'Kottayam',
  'Idukki',
  'Ernakulam',
  'Thrissur',
  'Palakkad',
  'Malappuram',
  'Kozhikode',
  'Wayanad',
  'Kannur',
  'Kasaragod',
];

const normalize = (value) => String(value || '').trim().toLowerCase();

const main = async () => {
  try {
    await connectDB();

    const districtSet = new Set(KERALA_DISTRICTS.map(normalize));

    const bookingsBefore = await Booking.countDocuments();
    const allRegionsBefore = await Region.find({}, 'name');
    const allEmployeesBefore = await Employee.find({}, 'name email phone type artistRole');
    const legacyCustomersBefore = await Customer.find(
      { email: /@legacy\.local$/i },
      '_id'
    );

    const bookingDeleteResult = await Booking.deleteMany({});

    const regionsToDelete = allRegionsBefore.filter(
      (region) => !districtSet.has(normalize(region.name))
    );

    let deletedRegions = 0;
    if (regionsToDelete.length > 0) {
      const ids = regionsToDelete.map((region) => region._id);
      const deleteRegionsResult = await Region.deleteMany({ _id: { $in: ids } });
      deletedRegions = deleteRegionsResult.deletedCount;
    }

    let createdRegions = 0;
    for (const district of KERALA_DISTRICTS) {
      const existing = await Region.findOne({ name: district });
      if (!existing) {
        await Region.create({ name: district, status: 'active' });
        createdRegions += 1;
      }
    }

    const legacyEmployees = allEmployeesBefore.filter((employee) => {
      const email = String(employee.email || '').trim();
      const phone = String(employee.phone || '').trim();
      const type = String(employee.type || '').trim().toLowerCase();
      const artistRole = String(employee.artistRole || '').trim().toLowerCase();

      return !email && !phone && type === 'outsource' && artistRole === 'artist';
    });

    let deletedEmployees = 0;
    if (legacyEmployees.length > 0) {
      const ids = legacyEmployees.map((employee) => employee._id);
      const deleteEmployeesResult = await Employee.deleteMany({
        _id: { $in: ids },
      });
      deletedEmployees = deleteEmployeesResult.deletedCount;
    }

    let deletedCustomers = 0;
    if (legacyCustomersBefore.length > 0) {
      const ids = legacyCustomersBefore.map((customer) => customer._id);
      const deleteCustomersResult = await Customer.deleteMany({
        _id: { $in: ids },
      });
      deletedCustomers = deleteCustomersResult.deletedCount;
    }

    console.log('Legacy reset complete.');
    console.log(`Bookings before: ${bookingsBefore}`);
    console.log(`Bookings deleted: ${bookingDeleteResult.deletedCount}`);
    console.log(`Regions deleted: ${deletedRegions}`);
    console.log(`Kerala districts ensured: ${KERALA_DISTRICTS.length}`);
    console.log(`Missing districts created: ${createdRegions}`);
    console.log(`Legacy artists deleted: ${deletedEmployees}`);
    console.log(`Legacy customers deleted: ${deletedCustomers}`);
    console.log('Remaining regions:');

    const remainingRegions = await Region.find({}, 'name').sort({ name: 1 });
    remainingRegions.forEach((region) => console.log(`- ${region.name}`));
  } catch (error) {
    console.error(`Failed to reset legacy import data: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

main();
