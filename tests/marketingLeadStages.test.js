// Pure unit tests: node --test tests/marketingLeadStages.test.js — how the Marketing screens read a CRM lead.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../utils/marketingLeadStages.js';

test('stages: the CRM status grouped as the document shows it; a pending "lost" is still open', () => {
  const by = (s) => L.stageOfLead(s);
  assert.deepEqual(['New', 'Contacted', 'Qualified', 'Follow-up', 'Pending Lost Approval', 'Lost', 'Converted'].map(by), ['new', 'in_progress', 'in_progress', 'in_progress', 'in_progress', 'not_converted', 'converted']);
  assert.equal(by('something odd'), 'new');
  assert.equal(L.isQualified('Qualified'), true);
  assert.equal(L.isQualified('Follow-up'), true);
  assert.equal(L.isQualified('Converted'), true);
  assert.equal(L.isQualified('Contacted'), false);
  assert.equal(L.isQualified('Lost'), false);
  assert.equal(L.isOpen('Follow-up'), true);
  assert.equal(L.isOpen('Pending Lost Approval'), true);
  assert.equal(L.isOpen('Lost'), false);
  assert.equal(L.isOpen('Converted'), false);
});

test('quality is the CRM priority — Hot, Warm, Nurture, Cold; no priority (or an unknown one) is "Not rated", never Warm', () => {
  assert.equal(L.qualityOf({ priority: 'Hot' }), 'Hot');
  assert.equal(L.qualityOf({ priority: 'Cold' }), 'Cold');
  assert.equal(L.qualityOf({ priority: 'Nurture' }), 'Nurture');
  assert.equal(L.qualityOf({ priority: 'nurture ' }), 'Nurture');
  assert.equal(L.qualityOf({ priority: 'Warm' }), 'Warm');
  assert.equal(L.qualityOf({}), 'Not rated');
  assert.equal(L.qualityOf({ priority: '' }), 'Not rated');
  assert.equal(L.qualityOf({ priority: 'Lukewarm' }), 'Not rated');
  assert.deepEqual(L.QUALITIES, ['Hot', 'Warm', 'Nurture', 'Cold']);
});

test('the day is the lead date, else the day it was created, in India', () => {
  assert.equal(L.leadDay({ leadDate: '2026-11-03T20:00:00Z', createdAt: '2026-11-01T00:00:00Z' }), '2026-11-04');
  assert.equal(L.leadDay({ createdAt: '2026-11-01T20:00:00Z' }), '2026-11-02');
});

test('sources: the CRM canonical values, legacy spellings, and what is an ad', () => {
  const k = L.sourceKeyOf;
  assert.equal(k('WhatsApp (Organic)'), 'whatsapp');
  assert.equal(k(''), 'whatsapp', 'the CRM default');
  assert.equal(k(undefined), 'whatsapp');
  assert.equal(k('IG Leads — Main Page'), 'ig_main');
  assert.equal(k('IG Leads — Kerala Page'), 'ig_kerala');
  assert.equal(k('Instagram (Organic)'), 'ig_main');
  assert.equal(k('Instagram Kerala'), 'ig_kerala');
  assert.equal(k('Paid Ads Leads'), 'meta_ads');
  assert.equal(k('Trial Campaign Leads'), 'meta_ads');
  assert.equal(k('Instagram (Paid)'), 'meta_ads', 'an Instagram ad is an ad');
  assert.equal(k('Facebook Ads'), 'meta_ads');
  assert.equal(k('YouTube'), 'youtube');
  assert.equal(k('Reference'), 'reference');
  assert.equal(k('Walk-in'), 'walk_in');
  assert.equal(k('Other'), 'other');
  assert.equal(k('Cold call'), 'other');
  assert.equal(k('Website'), 'website');
  assert.equal(k('Website form'), 'website');
  assert.equal(k('web site enquiry'), 'website');
  assert.equal(L.sourceLabelOf('website'), 'Website');
  assert.equal(L.sourceLabelOf('ig_kerala'), 'Instagram (Kerala)');
  assert.equal(L.sourceLabelOf('nope'), 'Other');
  assert.equal(L.isOrganicInstagram('IG Leads — Main Page'), true);
  assert.equal(L.isOrganicInstagram('Paid Ads Leads'), false);
});

test('brand: an Instagram page names it; otherwise the region or district', () => {
  assert.equal(L.leadBrand({ source: 'IG Leads — Kerala Page' }), 'kerala');
  assert.equal(L.leadBrand({ source: 'IG Leads — Main Page', region: 'Calicut' }), 'main');
  assert.equal(L.leadBrand({ source: 'WhatsApp (Organic)', region: 'Calicut' }), 'kerala');
  assert.equal(L.leadBrand({ source: 'Walk-in', district: 'Ernakulam' }), 'kerala');
  assert.equal(L.leadBrand({ source: 'Paid Ads Leads', region: 'Bangalore' }), 'main');
  assert.equal(L.leadBrand({}), 'main');
});

test('brand: a lead of a campaign belongs to the CAMPAIGN\'s brand (as on the Campaigns hub), before the page or the region', () => {
  assert.equal(L.leadBrand({ source: 'Paid Ads Leads', region: 'Bangalore', campaignBrand: 'kerala' }), 'kerala');
  assert.equal(L.leadBrand({ source: 'IG Leads — Main Page', campaignBrand: 'kerala' }), 'kerala');
  assert.equal(L.leadBrand({ source: 'WhatsApp (Organic)', region: 'Kochi', campaignBrand: 'main' }), 'main');
  assert.equal(L.leadBrand({ source: 'WhatsApp (Organic)', region: 'Kochi', campaignBrand: 'mars' }), 'kerala', 'an unknown value is ignored');
});
