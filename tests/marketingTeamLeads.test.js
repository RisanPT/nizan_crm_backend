// Pure unit tests: node --test tests/marketingTeamLeads.test.js
// Team Dashboard → Performance: lead-to-booking per member, by the Lead Report's own rules (arrival day, brand, booked).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadConversionByUser } from '../utils/marketingTeamLeads.js';

let n = 0;
const lead = (assignedTo, extra = {}) => ({ _id: `l${++n}`, assignedTo, status: 'New', source: 'WhatsApp', region: 'Bangalore', leadDate: new Date('2026-11-03T05:00:00Z'), createdAt: new Date('2026-10-01T05:00:00Z'), ...extra });
const live = { _id: 'b1', status: 'confirmed' };
const dead = { _id: 'b2', status: 'cancelled' };
const ctx = { bookings: new Map([['b1', live], ['b2', dead]]) };

test('per login: leads that arrived in the range, how many are booked (a live booking), and the rate (one decimal)', () => {
  const leads = [
    lead('u1', { status: 'Converted', bookingId: 'b1' }),
    lead('u1'),
    lead('u1', { status: 'Converted', bookingId: 'b2' }), // its booking was cancelled: no booking
    lead('u1', { status: 'Converted', bookingId: 'b1', leadDate: new Date('2026-10-20T05:00:00Z') }), // arrived before the range
    lead('u1', { status: 'Converted', bookingId: 'b1', leadDate: null, createdAt: new Date('2026-11-04T05:00:00Z') }), // no leadDate → the day it was made
    lead('u2', { status: 'Lost' }),
    lead('u9', { status: 'Converted', bookingId: 'b1' }), // nobody we asked about
  ];
  const r = leadConversionByUser({ leads, userIds: ['u1', 'u2', 'u3'], from: '2026-11-01', to: '2026-11-07', ctx });
  assert.deepEqual(r.get('u1'), { leads: 4, booked: 2, rate: 50 });
  assert.deepEqual(r.get('u2'), { leads: 1, booked: 0, rate: 0 });
  assert.deepEqual(r.get('u3'), { leads: 0, booked: 0, rate: null }, 'no lead → no rate, never 0%');
  assert.equal(r.has('u9'), false);
});

test('the brand is the Lead Report\'s: an Instagram page names it, else the region', () => {
  const leads = [lead('u1', { region: 'Calicut', status: 'Converted', bookingId: 'b1' }), lead('u1', { source: 'IG Leads Kerala' }), lead('u1')];
  assert.deepEqual(leadConversionByUser({ leads, userIds: ['u1'], from: '2026-11-01', to: '2026-11-07', brand: 'kerala', ctx }).get('u1'), { leads: 2, booked: 1, rate: 50 });
  assert.deepEqual(leadConversionByUser({ leads, userIds: ['u1'], from: '2026-11-01', to: '2026-11-07', brand: 'main', ctx }).get('u1'), { leads: 1, booked: 0, rate: 0 });
  assert.equal(leadConversionByUser({ leads, userIds: ['u1'], from: '2026-11-01', to: '2026-11-07', ctx }).get('u1').leads, 3);
});
