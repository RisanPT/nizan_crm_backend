import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables
dotenv.config();

const regionSchema = new mongoose.Schema({ name: String, status: String });
const Region = mongoose.model('Region', regionSchema);

const districtSchema = new mongoose.Schema({ name: String, status: String });
const District = mongoose.model('District', districtSchema);

// Custom normalization map
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

async function main() {
  try {
    const mongoUri = process.env.MONGO_URI;
    await mongoose.connect(mongoUri);

    const regions = await Region.find({}).lean();
    const districts = await District.find({}).lean();

    console.log('--- Custom Name-Based Mapping Test ---');
    let mappedCount = 0;
    
    for (const r of regions) {
      const normRegion = normalizeName(r.name);
      const match = districts.find(d => normalizeName(d.name) === normRegion);
      
      if (match) {
        console.log(`Region "${r.name}" (${r._id}) matches District "${match.name}" (${match._id})`);
        mappedCount++;
      } else {
        console.log(`WARNING: Region "${r.name}" (${r._id}) has NO matching District!`);
      }
    }

    console.log(`\nSuccessfully mapped ${mappedCount} out of ${regions.length} regions.`);
  } catch (error) {
    console.error('Error running script:', error);
  } finally {
    await mongoose.connection.close();
  }
}

main();
