/**
 * seedKeralaDistricts.js
 * ──────────────────────────────────────────────────────────────────────────
 * Seeds all 13 Kerala districts and 183 pincodes from kerala_pincodes.csv.
 *
 * Strategy (safe to run multiple times):
 *   1. Ensure "Kerala" State exists (find-or-create).
 *   2. Ensure a "Kerala" Region exists linked to that State (find-or-create).
 *   3. Upsert each of the 13 districts linked to that Region.
 *   4. Upsert each pincode linked to its district.
 *
 * Usage:
 *   node scripts/seedKeralaDistricts.js
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// ── Inline schemas (avoids import-order issues with existing models) ────────
const zoneSchema     = new mongoose.Schema({ name: String, status: { type: String, default: 'active' } });
const stateSchema    = new mongoose.Schema({ name: String, zone: { type: mongoose.Schema.Types.ObjectId, ref: 'Zone' }, status: { type: String, default: 'active' } });
const regionSchema   = new mongoose.Schema({ name: String, state: { type: mongoose.Schema.Types.ObjectId, ref: 'State', default: null }, status: { type: String, default: 'active' } });
const districtSchema = new mongoose.Schema({ name: String, region: { type: mongoose.Schema.Types.ObjectId, ref: 'Region' }, status: { type: String, default: 'active' } });
const pincodeSchema  = new mongoose.Schema({ code: { type: String, unique: true }, district: { type: mongoose.Schema.Types.ObjectId, ref: 'District' }, status: { type: String, default: 'active' } });

// Use existing compiled models if they already exist (avoids OverwriteModelError)
const Zone     = mongoose.models.Zone     || mongoose.model('Zone',     zoneSchema);
const State    = mongoose.models.State    || mongoose.model('State',    stateSchema);
const Region   = mongoose.models.Region   || mongoose.model('Region',   regionSchema);
const District = mongoose.models.District || mongoose.model('District', districtSchema);
const Pincode  = mongoose.models.Pincode  || mongoose.model('Pincode',  pincodeSchema);

// ── Kerala data (from kerala_pincodes.csv) ───────────────────────────────────
const KERALA_DISTRICTS = [
  'Thiruvananthapuram',
  'Kollam',
  'Pathanamthitta',
  'Alappuzha',
  'Kottayam',
  'Idukki',
  'Ernakulam',
  'Thrissur',
  'Malappuram',
  'Kozhikode',
  'Wayanad',
  'Kannur',
  'Kasaragod',
];

/** pincode → district name */
const PINCODES = {
  // Thiruvananthapuram
  '695001': 'Thiruvananthapuram', '695002': 'Thiruvananthapuram',
  '695003': 'Thiruvananthapuram', '695004': 'Thiruvananthapuram',
  '695005': 'Thiruvananthapuram', '695006': 'Thiruvananthapuram',
  '695007': 'Thiruvananthapuram', '695008': 'Thiruvananthapuram',
  '695009': 'Thiruvananthapuram', '695010': 'Thiruvananthapuram',
  '695011': 'Thiruvananthapuram', '695012': 'Thiruvananthapuram',
  '695013': 'Thiruvananthapuram', '695014': 'Thiruvananthapuram',
  '695015': 'Thiruvananthapuram', '695121': 'Thiruvananthapuram',
  '695101': 'Thiruvananthapuram', '695141': 'Thiruvananthapuram',
  '695521': 'Thiruvananthapuram',
  // Kollam
  '691001': 'Kollam', '691002': 'Kollam', '691003': 'Kollam',
  '691004': 'Kollam', '691005': 'Kollam', '691006': 'Kollam',
  '691007': 'Kollam', '691008': 'Kollam', '691009': 'Kollam',
  '691010': 'Kollam', '691141': 'Kollam', '691523': 'Kollam',
  '691581': 'Kollam', '691582': 'Kollam',
  // Pathanamthitta
  '689641': 'Pathanamthitta', '689642': 'Pathanamthitta',
  '689643': 'Pathanamthitta', '689537': 'Pathanamthitta',
  '689804': 'Pathanamthitta', '689533': 'Pathanamthitta',
  '689549': 'Pathanamthitta',
  // Alappuzha
  '688001': 'Alappuzha', '688002': 'Alappuzha', '688003': 'Alappuzha',
  '688004': 'Alappuzha', '688005': 'Alappuzha', '688006': 'Alappuzha',
  '688007': 'Alappuzha', '688008': 'Alappuzha', '688009': 'Alappuzha',
  '688010': 'Alappuzha', '688573': 'Alappuzha', '690102': 'Alappuzha',
  '689101': 'Alappuzha',
  // Kottayam (686001 shared with Alappuzha — Kottayam wins per CSV order)
  '686001': 'Kottayam', '686002': 'Kottayam', '686003': 'Kottayam',
  '686004': 'Kottayam', '686005': 'Kottayam', '686006': 'Kottayam',
  '686007': 'Kottayam', '686008': 'Kottayam', '686009': 'Kottayam',
  '686010': 'Kottayam', '686110': 'Kottayam', '686631': 'Kottayam',
  '686602': 'Kottayam', '685509': 'Kottayam',
  // Idukki
  '685587': 'Idukki', '685612': 'Idukki', '685506': 'Idukki',
  '685584': 'Idukki', '685574': 'Idukki', '685501': 'Idukki',
  // Ernakulam
  '682001': 'Ernakulam', '682002': 'Ernakulam', '682003': 'Ernakulam',
  '682004': 'Ernakulam', '682005': 'Ernakulam', '682006': 'Ernakulam',
  '682007': 'Ernakulam', '682008': 'Ernakulam', '682009': 'Ernakulam',
  '682010': 'Ernakulam', '682011': 'Ernakulam', '682012': 'Ernakulam',
  '682013': 'Ernakulam', '682014': 'Ernakulam', '682015': 'Ernakulam',
  '682016': 'Ernakulam', '682017': 'Ernakulam', '682018': 'Ernakulam',
  '682019': 'Ernakulam', '682020': 'Ernakulam', '682021': 'Ernakulam',
  '682022': 'Ernakulam', '686701': 'Ernakulam', '686101': 'Ernakulam',
  '683542': 'Ernakulam',
  // Thrissur
  '680001': 'Thrissur', '680002': 'Thrissur', '680003': 'Thrissur',
  '680004': 'Thrissur', '680005': 'Thrissur', '680006': 'Thrissur',
  '680007': 'Thrissur', '680008': 'Thrissur', '680009': 'Thrissur',
  '680010': 'Thrissur', '680011': 'Thrissur', '680012': 'Thrissur',
  '680013': 'Thrissur', '680014': 'Thrissur', '680015': 'Thrissur',
  '680503': 'Thrissur', '680307': 'Thrissur', '680667': 'Thrissur',
  '680121': 'Thrissur', '679101': 'Thrissur',
  // Malappuram
  '676501': 'Malappuram', '676502': 'Malappuram', '676503': 'Malappuram',
  '676504': 'Malappuram', '676505': 'Malappuram', '676506': 'Malappuram',
  '676507': 'Malappuram', '676508': 'Malappuram', '676301': 'Malappuram',
  '676523': 'Malappuram', '676121': 'Malappuram', '679331': 'Malappuram',
  '679586': 'Malappuram',
  // Kozhikode
  '673001': 'Kozhikode', '673002': 'Kozhikode', '673003': 'Kozhikode',
  '673004': 'Kozhikode', '673005': 'Kozhikode', '673006': 'Kozhikode',
  '673007': 'Kozhikode', '673008': 'Kozhikode', '673009': 'Kozhikode',
  '673010': 'Kozhikode', '673011': 'Kozhikode', '673012': 'Kozhikode',
  '673013': 'Kozhikode', '673014': 'Kozhikode', '673015': 'Kozhikode',
  '673016': 'Kozhikode', '673104': 'Kozhikode', '673507': 'Kozhikode',
  '673571': 'Kozhikode', '673602': 'Kozhikode',
  // Wayanad
  '673121': 'Wayanad', '673122': 'Wayanad', '673123': 'Wayanad',
  '673591': 'Wayanad', '673592': 'Wayanad', '673576': 'Wayanad',
  // Kannur
  '670001': 'Kannur', '670002': 'Kannur', '670003': 'Kannur',
  '670004': 'Kannur', '670005': 'Kannur', '670006': 'Kannur',
  '670007': 'Kannur', '670008': 'Kannur', '670009': 'Kannur',
  '670010': 'Kannur', '670011': 'Kannur', '670012': 'Kannur',
  '670101': 'Kannur', '673310': 'Kannur', '670307': 'Kannur',
  '671532': 'Kannur',
  // Kasaragod
  '671533': 'Kasaragod', '671534': 'Kasaragod', '671531': 'Kasaragod',
  '671542': 'Kasaragod', '671541': 'Kasaragod', '671543': 'Kasaragod',
};

// ── Helper: find-or-create ───────────────────────────────────────────────────
async function findOrCreate(Model, query, extra = {}) {
  let doc = await Model.findOne(query).lean();
  if (!doc) {
    doc = await Model.create({ ...query, ...extra });
    console.log(`  ✚ Created ${Model.modelName}: ${JSON.stringify(query)}`);
  } else {
    console.log(`  ✔ Found   ${Model.modelName}: ${JSON.stringify(query)}`);
  }
  return doc;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Connecting to MongoDB…');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected.\n');

  // 1. Ensure a Zone exists for South India
  const zone = await findOrCreate(Zone, { name: 'South India' });

  // 2. Ensure Kerala State
  const state = await findOrCreate(State, { name: 'Kerala' }, { zone: zone._id });

  // 3. Ensure Kerala Region (used as parent for districts)
  const region = await findOrCreate(Region, { name: 'Kerala' }, { state: state._id });

  console.log('\n── Districts ──────────────────────────────────');

  // 4. Upsert all 13 districts
  const districtMap = {}; // name → ObjectId
  for (const name of KERALA_DISTRICTS) {
    const doc = await District.findOneAndUpdate(
      { name, region: region._id },
      { name, region: region._id, status: 'active' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    districtMap[name] = doc._id;
    console.log(`  ✔ District: ${name} (${doc._id})`);
  }

  console.log('\n── Pincodes ───────────────────────────────────');

  // 5. Upsert all pincodes
  let inserted = 0, skipped = 0;
  for (const [code, districtName] of Object.entries(PINCODES)) {
    const districtId = districtMap[districtName];
    if (!districtId) {
      console.warn(`  ⚠ No district found for pincode ${code} → "${districtName}"`);
      skipped++;
      continue;
    }
    await Pincode.findOneAndUpdate(
      { code },
      { $set: { district: districtId, status: 'active' } },
      { upsert: true, new: true }
    );
    inserted++;
  }

  console.log(`\n  Pincodes upserted : ${inserted}`);
  console.log(`  Pincodes skipped  : ${skipped}`);
  console.log('\n✅ Kerala district & pincode seed complete!');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  })
  .finally(() => mongoose.connection.close());
