import http from 'http';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });

import LeaveRequest from '../models/LeaveRequest.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { handleExternalLeaveRequest, decideLeaveDirectly } from '../controllers/leaveController.js';
import { dispatchLeaveCallback } from '../services/leaveCallbackService.js';

async function runTest() {
  console.log('=== LEAVE WEBHOOK TWO-WAY INTEGRATION TEST ===\n');

  // 1. Connect to MongoDB
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.\n');

  // 2. Spin up a mock external HTTP server to listen for the callback
  let receivedCallback = null;
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        receivedCallback = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: JSON.parse(body),
        };
        console.log('[Mock Callback Server] Received webhook from CRM:');
        console.log('  Headers Authorization:', req.headers['authorization']);
        console.log('  Headers X-API-Key:', req.headers['x-api-key']);
        console.log('  Body:', JSON.stringify(receivedCallback.body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: receivedCallback.body.status, applied: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });

  const mockPort = 9876;
  await new Promise((resolve) => mockServer.listen(mockPort, resolve));
  console.log(`Mock external callback server listening on port ${mockPort}\n`);

  try {
    const testReqId = 99001 + Math.floor(Math.random() * 1000);
    const callbackUrl = `http://127.0.0.1:${mockPort}/modules/api/leave_callback.php`;
    const apiKey = process.env.TIMEBOX_API_KEY || '4329860ee528ee15e4b991fd4a976643610c38b434f70112';

    // 3. Test Auth Failure (No Token)
    console.log('--- TEST 1: Auth failure with missing token ---');
    const mockReq1 = {
      headers: {},
      body: { request_id: testReqId },
    };
    let status1 = null;
    let json1 = null;
    const mockRes1 = {
      status(code) { status1 = code; return this; },
      json(data) { json1 = data; return this; },
    };
    await handleExternalLeaveRequest(mockReq1, mockRes1);
    console.log(`Response Status: ${status1} (Expected 401)`);
    console.log('Response Body:', json1);
    if (status1 !== 401) throw new Error('Auth failure test did not return 401');

    // 4. Test Inbound Leave Submission with Bearer Token
    console.log('\n--- TEST 2: Inbound Leave Submission with Bearer Token ---');
    const samplePayload = {
      request_id: testReqId,
      employee: {
        id: 2026,
        name: 'Abhiram Test',
        email: 'abhiram.test@example.com',
        designation: 'Marketing Manager',
        department: 'Marketing',
      },
      department_head: {
        id: 5,
        name: 'Jane Doe',
        email: 'jane.doe@example.com',
      },
      leave_type: 'Paid',
      start_date: '2026-11-21',
      end_date: '2026-11-21',
      working_days: 1,
      reason: 'Family function',
      requested_at: '2026-10-22T11:38:07+05:30',
      callback_url: callbackUrl,
    };

    const mockReq2 = {
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
      body: samplePayload,
    };
    let status2 = null;
    let json2 = null;
    const mockRes2 = {
      status(code) { status2 = code; return this; },
      json(data) { json2 = data; return this; },
    };

    await handleExternalLeaveRequest(mockReq2, mockRes2);
    console.log(`Response Status: ${status2} (Expected 201)`);
    console.log('Response Body:', json2);
    if (status2 !== 201 || !json2.ok) throw new Error('Submission failed to return 201');
    const createdLeaveId = json2.id;

    // 5. Test Idempotency (Repeat submission)
    console.log('\n--- TEST 3: Idempotent resubmission of same request_id ---');
    let status3 = null;
    let json3 = null;
    const mockRes3 = {
      status(code) { status3 = code; return this; },
      json(data) { json3 = data; return this; },
    };
    await handleExternalLeaveRequest(mockReq2, mockRes3);
    console.log(`Response Status: ${status3} (Expected 200)`);
    console.log('Response Body:', json3);
    if (status3 !== 200 || !json3.ok) throw new Error('Idempotent resubmission failed');

    // 6. Verify in DB
    console.log('\n--- TEST 4: Verify record in DB ---');
    const dbRecord = await LeaveRequest.findById(createdLeaveId);
    console.log('DB Record:');
    console.log(`  _id: ${dbRecord._id}`);
    console.log(`  employeeName: ${dbRecord.employeeName}`);
    console.log(`  externalRequestId: ${dbRecord.externalRequestId}`);
    console.log(`  callbackUrl: ${dbRecord.callbackUrl}`);
    console.log(`  status: ${dbRecord.status}`);
    console.log(`  approvalId: ${dbRecord.approvalId}`);

    // 7. Test Decision & Outbound Webhook Callback
    console.log('\n--- TEST 5: Decide Leave in CRM (Approved) & Verify Outbound Webhook ---');
    const adminUser = await User.findOne({ role: 'admin' });
    const mockReqDecision = {
      params: { id: createdLeaveId },
      user: adminUser || { _id: new mongoose.Types.ObjectId(), name: 'Jane Doe', role: 'admin' },
      body: { status: 'approved', note: 'Enjoy the family function!' },
    };
    let decisionStatus = null;
    let decisionJson = null;
    const mockResDecision = {
      status(code) { decisionStatus = code; return this; },
      json(data) { decisionJson = data; return this; },
    };

    await decideLeaveDirectly(mockReqDecision, mockResDecision);
    console.log('Decision result callback status:', decisionJson?.callback);

    // Wait 1 second for callback handling
    await new Promise((r) => setTimeout(r, 1000));

    if (!receivedCallback) {
      throw new Error('Mock callback server did not receive webhook!');
    }

    console.log('\n--- VERIFYING RECEIVED CALLBACK PAYLOAD ---');
    console.log('Received payload:', receivedCallback.body);
    if (receivedCallback.body.request_id !== testReqId) {
      throw new Error(`request_id mismatch! Expected ${testReqId}, got ${receivedCallback.body.request_id}`);
    }
    if (receivedCallback.body.status !== 'approved') {
      throw new Error(`status mismatch! Expected approved, got ${receivedCallback.body.status}`);
    }
    console.log('All callback assertions PASSED!');

    // 8. Clean up test records
    await LeaveRequest.findByIdAndDelete(createdLeaveId);
    await Employee.findOneAndDelete({ email: 'abhiram.test@example.com' });
    console.log('\nTest cleanup complete.');
    console.log('\n🎉 ALL INTEGRATION TESTS PASSED 100%! 🎉');
  } finally {
    mockServer.close();
    await mongoose.disconnect();
  }
}

runTest().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
