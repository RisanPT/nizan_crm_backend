// Pure unit tests: node --test tests/metaAds.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  META_SYNC_MAX_DAYS,
  adAccountsFrom,
  adsConfig,
  autoSyncDue,
  batches,
  chunkRange,
  importRowOf,
  istToday,
  mergeUnlinked,
  metaLabel,
  resultsOf,
  syncRange,
} from '../utils/metaAds.js';
import { cleanImportInput } from '../utils/marketingCampaignInput.js';

test('ad accounts: act_ added, brand per account (kerala when not said), junk and repeats left out', () => {
  assert.deepEqual(adAccountsFrom('act_123:main, 456 , 789:KERALA; act_123:kerala, abc:main, 99:mars'), [
    { id: 'act_123', brand: 'main' },
    { id: 'act_456', brand: 'kerala' },
    { id: 'act_789', brand: 'kerala' },
    { id: 'act_99', brand: 'kerala' },
  ]);
  assert.deepEqual(adAccountsFrom(''), []);
  assert.deepEqual(adAccountsFrom(undefined), []);
});

test('config: ready only with the app secret, the token and an ad account; Lead Ads\' verify token is not needed', () => {
  assert.equal(adsConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't' }).ready, false);
  const c = adsConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't', META_AD_ACCOUNTS: '1:main' });
  assert.equal(c.ready, true);
  assert.deepEqual(c.has, { appSecret: true, token: true, accounts: true });
  assert.deepEqual(c.accounts, [{ id: 'act_1', brand: 'main' }]);
});

test('days: the last N days up to today, or a range; never past today, never over 92 days', () => {
  const today = '2026-11-18';
  assert.deepEqual(syncRange({ days: 3 }, today), { from: '2026-11-16', to: '2026-11-18' });
  assert.deepEqual(syncRange({ days: 1 }, today), { from: today, to: today });
  assert.deepEqual(syncRange({ days: META_SYNC_MAX_DAYS }, today).from, '2026-08-19');
  assert.ok(syncRange({ days: 93 }, today).error);
  assert.ok(syncRange({ days: 0 }, today).error);
  assert.ok(syncRange({ days: 2.5 }, today).error);
  assert.deepEqual(syncRange({ from: '2026-10-01', to: '2026-10-31' }, today), { from: '2026-10-01', to: '2026-10-31' });
  assert.ok(syncRange({ from: '2026-10-31', to: '2026-10-01' }, today).error);
  assert.ok(syncRange({ from: '2026-11-18', to: '2026-11-19' }, today).error, 'tomorrow');
  assert.ok(syncRange({ from: '2026-02-30', to: '2026-03-01' }, today).error, 'no such day');
  assert.ok(syncRange({ from: '2026-01-01', to: '2026-11-18' }, today).error, 'too long');
  assert.ok(syncRange({}, today).error);
  assert.equal(istToday(new Date('2026-11-18T19:00:00Z')), '2026-11-19', 'after 5:30 am IST the next day');
});

test('pieces of at most 15 days, end to end, nothing missed', () => {
  assert.deepEqual(chunkRange('2026-11-01', '2026-11-01'), [{ since: '2026-11-01', until: '2026-11-01' }]);
  const c = chunkRange('2026-10-01', '2026-11-18');
  assert.deepEqual(c.map((x) => [x.since, x.until]), [
    ['2026-10-01', '2026-10-15'],
    ['2026-10-16', '2026-10-30'],
    ['2026-10-31', '2026-11-14'],
    ['2026-11-15', '2026-11-18'],
  ]);
});

test('an automatic run is due 6 hours after the last one started', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  assert.equal(autoSyncDue(null, now), true);
  assert.equal(autoSyncDue(new Date('2026-11-18T06:00:00Z'), now), true);
  assert.equal(autoSyncDue(new Date('2026-11-18T07:00:00Z'), now), false);
});

test('results as Ads Manager counts them, by the campaign\'s objective', () => {
  const actions = [
    { action_type: 'link_click', value: '40' },
    { action_type: 'onsite_conversion.lead_grouped', value: '6' },
    { action_type: 'lead', value: '7' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '9' },
  ];
  assert.equal(resultsOf(actions, 'OUTCOME_LEADS'), 7);
  assert.equal(resultsOf(actions.filter((a) => a.action_type !== 'lead'), 'LEAD_GENERATION'), 6);
  assert.equal(resultsOf(actions, 'MESSAGES'), 9);
  assert.equal(resultsOf(actions, 'OUTCOME_ENGAGEMENT'), 9);
  assert.equal(resultsOf(actions, 'OUTCOME_TRAFFIC'), 40);
  assert.equal(resultsOf(actions, 'OUTCOME_AWARENESS'), 0);
  assert.equal(resultsOf(actions, ''), 7, 'no objective known: leads first');
  assert.equal(resultsOf([{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' }], ''), 3);
  assert.equal(resultsOf(undefined, 'OUTCOME_LEADS'), 0);
  assert.equal(resultsOf([{ action_type: 'lead', value: 'x' }], 'OUTCOME_LEADS'), 0);
});

test('Meta\'s rows become the import\'s own rows — and pass its checks', () => {
  const objectiveOf = new Map([['3001', 'OUTCOME_LEADS']]);
  const camp = importRowOf('campaign', { campaign_id: '3001', campaign_name: 'Kerala Nov', objective: 'OUTCOME_LEADS', spend: '1234.567', reach: '900', impressions: '800', inline_link_clicks: '1000', actions: [{ action_type: 'lead', value: '5' }], date_start: '2026-11-17' });
  assert.deepEqual(camp, { campaign: 'Kerala Nov', campaignId: '3001', day: '2026-11-17', spend: 1234.57, reach: 800, impressions: 800, clicks: 800, results: 5 });
  const ad = importRowOf('ad', { campaign_id: '3001', campaign_name: 'Kerala Nov', adset_id: '401', adset_name: 'Women 22-30', ad_id: '501', ad_name: 'Reel 17', spend: '100', impressions: '50', actions: [{ action_type: 'lead', value: '2' }], date_start: '2026-11-17' }, objectiveOf);
  assert.equal(ad.results, 2, 'the objective comes from the campaign rows');
  assert.deepEqual([ad.ad, ad.adId, ad.adSet, ad.adSetId], ['Reel 17', '501', 'Women 22-30', '401']);
  const seg = importRowOf('breakdown', { campaign_id: '3001', publisher_platform: 'instagram', platform_position: 'instagram_reels', spend: '10', impressions: '5', date_start: '2026-11-17' }, objectiveOf);
  assert.deepEqual([seg.platform, seg.position, seg.age, seg.gender], ['Instagram', 'Instagram Reels', '', '']);
  const ag = importRowOf('breakdown', { campaign_id: '3001', age: '25-34', gender: 'female', spend: '10', impressions: '5', date_start: '2026-11-17' });
  assert.deepEqual([ag.age, ag.gender], ['25-34', 'female']);
  assert.equal(importRowOf('campaign', { campaign_id: 'x', date_start: '2026-11-17' }), null);
  assert.equal(importRowOf('campaign', { campaign_id: '1', date_start: '17/11/2026' }), null);
  assert.equal(importRowOf('ad', { campaign_id: '1', date_start: '2026-11-17' }), null, 'an ad row needs its ad id');
  assert.equal(importRowOf('breakdown', { campaign_id: '1', date_start: '2026-11-17' }), null, 'a segment needs a segment');
  for (const [level, rows] of [['campaign', [camp]], ['ad', [ad]], ['breakdown', [seg, ag]]]) {
    const v = cleanImportInput({ level, rows }, { today: '2026-11-18' });
    assert.equal(v.ok, true, level);
    assert.deepEqual(v.value.skipped, [], `${level}: nothing skipped`);
  }
  const v = cleanImportInput({ level: 'breakdown', rows: [seg, ag] }, { today: '2026-11-18' });
  assert.deepEqual(v.value.rows.map((r) => r.dimension), ['placement', 'age+gender']);
  assert.equal(v.value.rows[0].placement, 'Instagram · Instagram Reels', 'the placement reads like an export\'s');
  assert.equal(metaLabel('audience_network'), 'Audience Network');
});

test('batches of 500', () => {
  assert.deepEqual(batches(Array.from({ length: 1201 }, (_, i) => i)).map((b) => b.length), [500, 500, 201]);
  assert.deepEqual(batches([]), []);
});

test('unlinked Meta campaigns: kept between runs, earliest day remembered, linked and ignored ones dropped', () => {
  const kept = [{ metaId: '1', name: 'Old name', firstDay: '2026-11-01', lastDay: '2026-11-05', spend: 50 }, { metaId: '2', name: 'Gone', firstDay: '2026-10-01', lastDay: '2026-10-02', spend: 5 }, { metaId: '3', name: 'Linked now' }];
  const seen = [{ metaId: '1', name: 'New name', from: '2026-11-16', to: '2026-11-18', spend: 30, accountId: 'act_9', brand: 'main', runFrom: '2026-11-16', runTo: '2026-11-18' }, { metaId: '4', name: 'Test', from: '2026-11-17', to: '2026-11-17', spend: 1 }];
  const out = mergeUnlinked(kept, seen, { ignored: ['4'], linked: ['3'] });
  assert.deepEqual(out.map((u) => u.metaId), ['1', '2']);
  assert.deepEqual([out[0].name, out[0].firstDay, out[0].lastDay, out[0].spend, out[0].brand], ['New name', '2026-11-01', '2026-11-18', 30, 'main']);
  assert.equal(out[1].name, 'Gone', 'one not seen this time stays listed: its spend is still not counted');
});
