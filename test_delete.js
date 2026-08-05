import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Employee from './models/Employee.js';

dotenv.config();
mongoose.connect(process.env.MONGO_URI);

async function test() {
  const emp = new Employee({ name: 'Test Delete', email: 'delete@test.com' });
  await emp.save();
  console.log('Saved:', emp._id);
  
  const fetched = await Employee.findById(emp._id);
  await fetched.deleteOne();
  console.log('Deleted');
  process.exit(0);
}
test();
