import dotenv from 'dotenv';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import ServicePackage from '../models/Package.js';
import Booking from '../models/Booking.js';
import Region from '../models/Region.js';
import District from '../models/District.js';

dotenv.config();

const MAPPING_OVERRIDES = {
  'kozhikode': 'kozhikkode',
  'kasaragod': 'kasargod',
  'kochi': 'ernakulam'
};

function normalizeName(name) {
  if (!name) return '';
  const clean = name.trim().toLowerCase();
  return MAPPING_OVERRIDES[clean] || clean;
}

async function runMigration() {
  try {
    await connectDB();
    console.log('Fetching regions, districts, packages, and bookings...');

    const regions = await Region.find({}).lean();
    const districts = await District.find({}).populate('region').lean();
    const packages = await ServicePackage.find({});
    const bookings = await Booking.find({});

    console.log(`Loaded ${regions.length} regions, ${districts.length} districts.`);
    console.log(`Loaded ${packages.length} packages, ${bookings.length} bookings.`);

    // Helper to find matching district for a region name
    const findDistrictForRegionName = (regionName) => {
      const normRegion = normalizeName(regionName);
      return districts.find(d => normalizeName(d.name) === normRegion);
    };

    // Helper to find matching district for a region ID
    const findDistrictForRegionId = (regionId) => {
      if (!regionId) return null;
      const reg = regions.find(r => r._id.toString() === regionId.toString());
      if (!reg) return null;
      return findDistrictForRegionName(reg.name);
    };

    // 1. Migrate Packages
    console.log('\n--- Migrating Packages ---');
    let migratedPackagesCount = 0;
    for (const pkg of packages) {
      if (pkg.regionPrices && pkg.regionPrices.length > 0) {
        console.log(`Package "${pkg.name}" has ${pkg.regionPrices.length} region price overrides.`);
        
        const districtPricesMap = new Map();
        
        // Load any existing district prices first to not lose them
        if (pkg.districtPrices && pkg.districtPrices.length > 0) {
          for (const dp of pkg.districtPrices) {
            if (dp.district) {
              districtPricesMap.set(dp.district.toString(), dp.price);
            }
          }
        }

        for (const rp of pkg.regionPrices) {
          if (!rp.region) continue;
          const district = findDistrictForRegionId(rp.region);
          if (district) {
            districtPricesMap.set(district._id.toString(), rp.price);
            console.log(`  -> Mapped region price ${rp.price} for region ID ${rp.region} to district "${district.name}"`);
          } else {
            console.log(`  -> WARNING: Could not find matching district for region ID ${rp.region}`);
          }
        }

        pkg.districtPrices = Array.from(districtPricesMap.entries()).map(([districtId, price]) => ({
          district: new mongoose.Types.ObjectId(districtId),
          price
        }));

        await pkg.save();
        migratedPackagesCount++;
        console.log(`Saved package "${pkg.name}" with ${pkg.districtPrices.length} district prices.`);
      }
    }
    console.log(`Migrated ${migratedPackagesCount} packages.`);

    // 2. Migrate Bookings
    console.log('\n--- Migrating Bookings ---');
    let migratedBookingsCount = 0;
    let skippedBookingsCount = 0;

    for (const booking of bookings) {
      // Find matching district using regionId, or fallback to region name
      let district = findDistrictForRegionId(booking.regionId);
      if (!district && booking.region) {
        district = findDistrictForRegionName(booking.region);
      }

      if (district) {
        booking.districtId = district._id;
        booking.district = district.name;
        
        // Also ensure regionId and region (String) point to the district's active parent region in the hierarchy
        if (district.region) {
          booking.regionId = district.region._id;
          booking.region = district.region.name;
        }

        await booking.save();
        migratedBookingsCount++;
        if (migratedBookingsCount <= 5) {
          console.log(`Booking #${booking.bookingNumber || booking._id}: set district="${booking.district}" (id: ${booking.districtId}), region="${booking.region}"`);
        }
      } else {
        skippedBookingsCount++;
        if (skippedBookingsCount <= 5) {
          console.log(`WARNING: Booking #${booking.bookingNumber || booking._id} could not be mapped (regionId: ${booking.regionId}, region: "${booking.region}")`);
        }
      }
    }
    console.log(`Migrated ${migratedBookingsCount} bookings (skipped ${skippedBookingsCount} unmappable).`);

    console.log('\nMigration completed successfully!');
  } catch (error) {
    console.error('Error running migration:', error);
  } finally {
    await mongoose.connection.close();
  }
}

runMigration();
