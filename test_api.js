import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const baseUrl = 'http://localhost:5001/api';

async function testArtistWorks() {
  try {
    // 1. Login as Admin
    console.log('Logging in as Admin...');
    const loginRes = await axios.post(`${baseUrl}/auth/login`, {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    });

    const token = loginRes.data.token;
    console.log('Logged in as Admin.');

    // 2. Get Leo's employeeId
    const usersRes = await axios.get(`${baseUrl}/auth/users`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const leo = (usersRes.data.items || usersRes.data).find(u => u.name === 'Leo');
    const employeeId = leo.employeeId;
    console.log('Target Employee ID (Leo/Fidha):', employeeId);

    // 3. Get Works for this artist
    console.log('Fetching works for artist...');
    const startTime = Date.now();
    const worksRes = await axios.get(`${baseUrl}/bookings/paged`, {
      params: { employeeId, page: 1, limit: 20 },
      headers: { Authorization: `Bearer ${token}` }
    });
    const duration = Date.now() - startTime;

    console.log(`Request completed in ${duration}ms`);
    console.log('Works count:', worksRes.data.items?.length);
    if (worksRes.data.items?.length > 0) {
        console.log('First work ID:', worksRes.data.items[0]._id);
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testArtistWorks();
