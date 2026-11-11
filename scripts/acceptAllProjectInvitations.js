import 'dotenv/config';
import mongoose from 'mongoose';
import Project from '../models/Project.js';

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.log('No MONGO_URI set.');
    return;
  }
  try {
    await mongoose.connect(uri);
    const projects = await Project.find({ 'departments.status': 'invited' });
    console.log(`Found ${projects.length} project(s) with pending invited departments.`);
    for (const p of projects) {
      for (const d of p.departments) {
        if (d.status === 'invited') {
          d.status = 'accepted';
          d.respondedAt = new Date();
        }
      }
      await p.save();
      console.log(`Updated project "${p.name}" (${p._id}) - all departments now accepted.`);
    }
    await mongoose.disconnect();
    console.log('Done.');
  } catch (err) {
    console.log('Could not run DB script (might be sandboxed or offline):', err.message);
  }
};

run();

