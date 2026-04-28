import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';

dotenv.config();

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const email = process.env.ADMIN_EMAIL.toLowerCase();
    const existing = await User.findOne({ email });
    
    if (existing) {
      console.log('Admin already exists');
      process.exit(0);
    }

    await User.create({
      name: process.env.ADMIN_NAME,
      email: email,
      password: process.env.ADMIN_PASSWORD,
      role: process.env.ADMIN_ROLE,
      active: true,
    });

    console.log('Admin user seeded successfully');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
};

seed();
