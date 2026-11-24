// Pure unit tests: node --test tests/marketingCampaignInput.test.js
// What the app may send for a campaign, an ad, a day's figures and a Meta Ads Manager import; how the file's rows are merged and matched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCampaignInput, cleanAdInput, cleanMetricInput, cleanImportInput, groupImportRows, matchImportGroups, matchImportAd, adMatchOf, dayToDate, MAX_IMPORT_ROWS } from '../utils/marketingCampaignInput.js';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const refused = (r, field) => {
  assert.equal(r.ok, false);
  if (field) assert.equal(r.field, field, r.message);
  return r.message;
};

test('a campaign: a name is required; every other field is optional and checked when sent', () => {
  const ok = cleanCampaignInput({ title: '  Bridal Campaign – Nov ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { title: 'Bridal Campaign – Nov', brand: 'kerala' }, 'a NEW campaign is Kerala unless the form says Main — the ads run only on the Kerala account');
  assert.equal(cleanCampaignInput({ title: 'Main one', brand: 'main' }).value.brand, 'main');
  assert.equal(cleanCampaignInput({ title: 'Renamed' }, { brand: 'main' }).value.brand, undefined, 'an update that does not send a brand leaves it alone');
  refused(cleanCampaignInput({}), 'title');
  refused(cleanCampaignInput({ title: 'x' }), 'title');
  refused(cleanCampaignInput({ title: 'Fine', brand: 'mars' }), 'brand');
  refused(cleanCampaignInput({ title: 'Fine', platform: 'tiktokk' }), 'platform');
  refused(cleanCampaignInput({ title: 'Fine', objective: 'fame' }), 'objective');
  refused(cleanCampaignInput({ title: 'Fine', status: 'done' }), 'status');
  const full = cleanCampaignInput({ title: 'Studio Tour', brand: 'kerala', platform: 'instagram', objective: 'lead_generation', status: 'paused', startDate: '2026-11-01', endDate: '2026-11-30', budget: '25,000', dailyBudget: 800.456, metaCampaignId: '120200000001', audienceNote: 'Brides 22–35', notes: 'n' });
  assert.equal(full.ok, true, full.message);
  assert.equal(full.value.budget, 25000, 'a typed 25,000 is read');
  assert.equal(full.value.dailyBudget, 800.46);
  assert.equal(full.value.channel, 'Instagram', 'the old screen\'s typed channel follows the platform');
  assert.equal(full.value.startDate.toISOString(), '2026-10-31T18:30:00.000Z', 'a start day is IST midnight');
  assert.equal(cleanCampaignInput({ title: 'Fine', platform: 'instagram', channel: 'IG reels' }).value.channel, 'IG reels', 'a channel the sender typed wins');
  assert.equal(cleanCampaignInput({ title: 'Fine', platform: '' }).value.platform, '', 'a platform can be cleared');
});

test('a campaign: budgets are amounts, dates are real days in order, the Meta ID has a plain shape', () => {
  for (const budget of [-1, 'lots', 1e12, NaN]) refused(cleanCampaignInput({ title: 'Fine', budget }), 'budget');
  assert.equal(cleanCampaignInput({ title: 'Fine', budget: '' }).value.budget, 0, 'blank is no budget');
  refused(cleanCampaignInput({ title: 'Fine', dailyBudget: -5 }), 'dailyBudget');
  refused(cleanCampaignInput({ title: 'Fine', startDate: '2026-02-31' }), 'startDate');
  refused(cleanCampaignInput({ title: 'Fine', endDate: '12 Nov' }), 'endDate');
  refused(cleanCampaignInput({ title: 'Fine', startDate: '2026-11-10', endDate: '2026-11-09' }), 'endDate');
  assert.equal(cleanCampaignInput({ title: 'Fine', startDate: '2026-11-10', endDate: '2026-11-10' }).ok, true, 'one-day campaign');
  assert.equal(cleanCampaignInput({ title: 'Fine', startDate: null, endDate: '' }).value.endDate, null, 'dates can be cleared');
  refused(cleanCampaignInput({ title: 'Fine', metaCampaignId: 'abc def' }), 'metaCampaignId');
  refused(cleanCampaignInput({ title: 'Fine', metaCampaignId: '<script>' }), 'metaCampaignId');
  refused(cleanCampaignInput({ title: 'Fine', metaCampaignId: 'x'.repeat(41) }), 'metaCampaignId');
  assert.equal(cleanCampaignInput({ title: 'Fine', metaCampaignId: ' 12036_ab-1 ' }).value.metaCampaignId, '12036_ab-1');
  // an update: only what was sent changes, and the dates are checked against the stored ones
  const existing = { startDate: new Date('2026-11-20T00:00:00+05:30'), endDate: null };
  assert.deepEqual(cleanCampaignInput({ budget: 5 }, existing).value, { budget: 5 });
  refused(cleanCampaignInput({ endDate: '2026-11-10' }, existing), 'endDate');
  assert.equal(cleanCampaignInput({ endDate: '2026-11-25' }, existing).ok, true);
  assert.equal(cleanCampaignInput({ title: 'x'.repeat(300) }).value.title.length, 160, 'long text is cut, not stored whole');
  assert.equal(dayToDate('2026-11-01').toISOString(), '2026-10-31T18:30:00.000Z');
});

test('an ad: a campaign and a name; links must be https; clicks cannot exceed impressions', () => {
  const ok = cleanAdInput({ campaignId: ID, name: 'Bridal Reel 1', adSetName: 'Brides 22–35', format: 'reel', status: 'paused', creativeUrl: 'https://drive.test/a', thumbUrl: 'https://drive.test/t.jpg', impressions: '12,000', clicks: 360, spend: '1500.5', results: 18 });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.value, { campaignId: ID, name: 'Bridal Reel 1', adSetName: 'Brides 22–35', format: 'reel', status: 'paused', creativeUrl: 'https://drive.test/a', thumbUrl: 'https://drive.test/t.jpg', impressions: 12000, clicks: 360, spend: 1500.5, results: 18 });
  refused(cleanAdInput({ name: 'No campaign' }), 'campaignId');
  refused(cleanAdInput({ campaignId: 'nope', name: 'Bad id' }), 'campaignId');
  refused(cleanAdInput({ campaignId: ID }), 'name');
  refused(cleanAdInput({ campaignId: ID, name: 'x' }), 'name');
  refused(cleanAdInput({ campaignId: ID, name: 'Fine', format: 'hologram' }), 'format');
  refused(cleanAdInput({ campaignId: ID, name: 'Fine', status: 'deleted' }), 'status');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'not a link', 'data:text/html,<b>']) {
    refused(cleanAdInput({ campaignId: ID, name: 'Fine', creativeUrl: url }), 'creativeUrl');
    refused(cleanAdInput({ campaignId: ID, name: 'Fine', thumbUrl: url }), 'thumbUrl');
  }
  assert.equal(cleanAdInput({ campaignId: ID, name: 'Fine', creativeUrl: '' }).value.creativeUrl, '', 'a link can be cleared');
  for (const spend of [-1, 'a lot']) refused(cleanAdInput({ campaignId: ID, name: 'Fine', spend }), 'spend');
  refused(cleanAdInput({ campaignId: ID, name: 'Fine', impressions: 1.5e11 }), 'impressions');
  refused(cleanAdInput({ campaignId: ID, name: 'Fine', impressions: 100, clicks: 101 }), 'clicks');
  assert.equal(cleanAdInput({ campaignId: ID, name: 'Fine', impressions: 100, clicks: 100 }).ok, true);
  refused(cleanAdInput({ campaignId: ID, name: 'Fine', clicks: 5 }), 'clicks');
  // an update checks what is sent against what is stored
  const stored = { impressions: 1000, clicks: 900 };
  assert.equal(cleanAdInput({ spend: 10 }, stored).ok, true);
  refused(cleanAdInput({ impressions: 500 }, stored), 'clicks');
  assert.equal(cleanAdInput({ impressions: 500, clicks: 100 }, stored).ok, true);
  assert.equal(cleanAdInput({ results: 3 }, stored).value.campaignId, undefined, 'an update that does not name the campaign leaves it');
});

test('a day\'s figures typed by hand: a real day that has happened; reach and clicks cannot exceed impressions', () => {
  const today = '2026-11-13';
  const ok = cleanMetricInput({ campaignId: ID, day: '2026-11-12', spend: '1,250.5', reach: 5000, impressions: 8000, clicks: 200, results: 10 }, { today });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.value, { campaignId: ID, day: '2026-11-12', spend: 1250.5, reach: 5000, impressions: 8000, clicks: 200, results: 10 });
  assert.deepEqual(cleanMetricInput({ campaignId: ID, day: today }, { today }).value, { campaignId: ID, day: today, spend: 0, reach: 0, impressions: 0, clicks: 0, results: 0 }, 'blank figures are zero');
  refused(cleanMetricInput({ day: '2026-11-12' }, { today }), 'campaignId');
  refused(cleanMetricInput({ campaignId: ID }, { today }), 'day');
  refused(cleanMetricInput({ campaignId: ID, day: '2026-02-30' }, { today }), 'day');
  refused(cleanMetricInput({ campaignId: ID, day: '13/11/2026' }, { today }), 'day');
  refused(cleanMetricInput({ campaignId: ID, day: '2026-11-14' }, { today }), 'day');
  refused(cleanMetricInput({ campaignId: ID, day: today, spend: -1 }, { today }), 'spend');
  refused(cleanMetricInput({ campaignId: ID, day: today, clicks: 'x' }, { today }), 'clicks');
  refused(cleanMetricInput({ campaignId: ID, day: today, results: 1.5e11 }, { today }), 'results');
  refused(cleanMetricInput({ campaignId: ID, day: today, reach: 900, impressions: 800 }, { today }), 'reach');
  refused(cleanMetricInput({ campaignId: ID, day: today, clicks: 801, impressions: 800 }, { today }), 'clicks');
  assert.equal(cleanMetricInput({ campaignId: ID, day: today, reach: 800, clicks: 800, impressions: 800 }, { today }).ok, true, 'equal is allowed');
});

const row = (extra = {}) => ({ campaign: 'Bridal Campaign – Nov', day: '2026-11-02', spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10, ...extra });

test('an import: a bad row is skipped with its reason, not the whole file; the request itself must be an import', () => {
  const today = '2026-11-13';
  const r = cleanImportInput({ rows: [row(), row({ day: '2026-11-03' }), row({ campaign: '' }), row({ day: 'Nov 3' }), row({ day: '2026-11-20' }), row({ spend: -5 }), row({ reach: 9000 }), row({ clicks: 9000 }), row({ campaignId: 'bad id!' }), null, row({ spend: 'abc' })], fileName: ' export.csv ' }, { today });
  assert.equal(r.ok, true);
  assert.equal(r.value.rows.length, 2);
  assert.deepEqual(r.value.skipped.map((s) => s.index), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(r.value.skipped.map((s) => s.reason), ['No campaign name.', 'The day is missing or not a real date.', 'The day has not happened yet.', 'Spend is not a number, zero or more.', 'Reach is higher than impressions.', 'Clicks are higher than impressions.', 'The campaign ID is not valid.', 'Not a row.', 'Spend is not a number, zero or more.']);
  assert.equal(r.value.fileName, 'export.csv');
  assert.deepEqual(r.value.rows[0], { campaign: 'Bridal Campaign – Nov', metaId: '', day: '2026-11-02', spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 });
  assert.equal(cleanImportInput({ rows: [row({ campaign: '', campaignId: '1203' })] }, { today }).value.rows.length, 1, 'an ID alone names the campaign');
  assert.equal(cleanImportInput({ rows: [row({ spend: '1,200.50', reach: '', impressions: '8,000' })] }, { today }).value.rows[0].spend, 1200.5);
  refused(cleanImportInput({}), 'rows');
  refused(cleanImportInput({ rows: [] }), 'rows');
  refused(cleanImportInput({ rows: 'a,b,c' }), 'rows');
  refused(cleanImportInput({ rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row()) }), 'rows');
  assert.equal(cleanImportInput({ rows: Array.from({ length: MAX_IMPORT_ROWS }, () => row()) }, { today }).ok, true);
});

test('an import: the options are checked — brand for campaigns to create, the explicit createMissing, the dry run', () => {
  const base = { rows: [row()] };
  const d = cleanImportInput(base).value;
  assert.equal(d.createMissing, false, 'creating campaigns is never the default');
  assert.equal(d.dryRun, false);
  assert.equal(d.brand, 'kerala', 'ads run on the Kerala account');
  assert.equal(d.importId, null);
  assert.equal(cleanImportInput({ ...base, createMissing: 'yes' }).value.createMissing, false, 'only a real true asks for it');
  assert.equal(cleanImportInput({ ...base, createMissing: true, brand: 'main' }).value.brand, 'main');
  assert.equal(cleanImportInput({ ...base, dryRun: true }).value.dryRun, true);
  refused(cleanImportInput({ ...base, brand: 'mars' }), 'brand');
  assert.equal(cleanImportInput({ ...base, importId: ID }).value.importId, ID);
  assert.equal(cleanImportInput({ ...base, importId: 'nope' }).value.importId, null);
  // no "today": the future check is off, everything else still applies
  assert.equal(cleanImportInput({ rows: [row({ day: '2030-01-01' })] }).value.rows.length, 1);
});

test('the file\'s rows are merged per campaign and day: breakdown rows ADD, so the same file twice gives the same totals', () => {
  const g = groupImportRows([
    row({ spend: 600.1, reach: 3000, impressions: 5000, clicks: 100, results: 6 }),
    row({ spend: 400.2, reach: 2000, impressions: 3000, clicks: 100, results: 4 }), // same campaign, same day: another breakdown row
    row({ day: '2026-11-03', spend: 50 }),
    row({ campaign: 'bridal campaign – nov', day: '2026-11-04', spend: 10 }), // the same name in another case is the same campaign
    row({ campaign: 'Studio Tour', day: '2026-11-02', spend: 7 }),
    row({ campaign: 'Renamed in Meta', metaId: '1203', day: '2026-11-02', spend: 3 }),
    row({ campaign: 'Renamed in Meta (copy)', metaId: '1203', day: '2026-11-03', spend: 4 }), // same Meta ID: one campaign, whatever the name says
  ]);
  assert.equal(g.length, 3);
  const bridal = g[0];
  assert.equal(bridal.rowCount, 4);
  assert.deepEqual([...bridal.days.keys()], ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(bridal.days.get('2026-11-02'), { spend: 1000.3, reach: 5000, impressions: 8000, clicks: 200, results: 10 });
  assert.equal(g[1].name, 'Studio Tour');
  assert.equal(g[2].metaId, '1203');
  assert.equal(g[2].rowCount, 2);
  assert.deepEqual([...g[2].days.keys()], ['2026-11-02', '2026-11-03']);
  assert.deepEqual(groupImportRows([]), []);
});

test('matching: by Meta ID first, then by exact title in any case; a shared title is ambiguous, never guessed', () => {
  const campaigns = [
    { _id: 'c1', title: 'Bridal Campaign – Nov', metaCampaignId: '' },
    { _id: 'c2', title: 'Studio Tour', metaCampaignId: '1203' },
    { _id: 'c3', title: 'Festive Offers', metaCampaignId: '' },
    { _id: 'c4', title: 'festive offers', metaCampaignId: '' },
    { _id: 'c5', title: 'Makeup Courses', metaCampaignId: '' },
  ];
  const groups = groupImportRows([
    row(), // exact title
    row({ campaign: 'BRIDAL CAMPAIGN – NOV', day: '2026-11-03' }), // same campaign, other case
    row({ campaign: 'Whatever Meta calls it', metaId: '1203' }), // matched by ID
    row({ campaign: 'Festive Offers' }), // two campaigns share it
    row({ campaign: 'Trial Makeup' }), // nothing
    row({ campaign: 'Makeup Courses – Enquiry' }), // a longer title is not the same campaign
    row({ campaign: 'Unknown', metaId: '9999' }), // an ID we do not have, no such name
  ]);
  const m = matchImportGroups(groups, campaigns);
  assert.deepEqual(m.matched.map((x) => [x.group.name, x.campaign._id]), [['Bridal Campaign – Nov', 'c1'], ['Whatever Meta calls it', 'c2']]);
  assert.deepEqual(m.unmatched.map((x) => [x.group.name, x.reason]), [['Festive Offers', 'ambiguous'], ['Trial Makeup', 'no_match'], ['Makeup Courses – Enquiry', 'no_match'], ['Unknown', 'no_match']]);
  // an unknown ID with the name of a campaign NOT linked to Meta yet matches by the name (and takes the ID)
  assert.equal(matchImportGroups(groupImportRows([row({ campaign: 'Makeup Courses', metaId: '5555' })]), campaigns).matched[0].campaign._id, 'c5');
  assert.deepEqual(matchImportGroups([], campaigns), { matched: [], unmatched: [] });
});

test('a Meta campaign never lands on a campaign of ours linked to ANOTHER Meta campaign of the same name (it would overwrite its spend)', () => {
  const campaigns = [
    { _id: 'c2', title: 'Studio Tour', metaCampaignId: '1203' },
    { _id: 'c5', title: 'Makeup Courses', metaCampaignId: '' },
  ];
  // Meta lets two campaigns share a name: 5555 is not 1203
  const other = matchImportGroups(groupImportRows([row({ campaign: 'Studio Tour', metaId: '5555' })]), campaigns);
  assert.deepEqual([other.matched.length, other.unmatched[0].reason], [0, 'other_meta_id']);
  // the right one still lands by its ID; a file WITHOUT the ID column still matches by the name
  assert.equal(matchImportGroups(groupImportRows([row({ campaign: 'Studio Tour', metaId: '1203' })]), campaigns).matched[0].campaign._id, 'c2');
  assert.equal(matchImportGroups(groupImportRows([row({ campaign: 'Studio Tour' })]), campaigns).matched[0].campaign._id, 'c2');
  // two Meta campaigns of one name, ours not linked yet: neither is guessed (each would overwrite the other's days)
  const two = matchImportGroups(groupImportRows([row({ campaign: 'Makeup Courses', metaId: '7001' }), row({ campaign: 'Makeup Courses', metaId: '7002' })]), campaigns);
  assert.deepEqual([two.matched.length, two.unmatched.map((u) => [u.group.metaId, u.reason])], [0, [['7001', 'same_name'], ['7002', 'same_name']]]);
  // the file's order is kept
  const mixed = matchImportGroups(groupImportRows([row({ campaign: 'Makeup Courses', metaId: '7001' }), row({ campaign: 'Studio Tour', metaId: '1203' })]), campaigns);
  assert.deepEqual(mixed.matched.map((x) => x.campaign._id), ['c5', 'c2']);
});

test('an ad without a Meta ad ID whose name two of the campaign\'s ads carry is not guessed (another ad would double its days)', () => {
  const ads = [
    { _id: 'a1', name: 'Reel 1', metaAdId: '120301' },
    { _id: 'a2', name: 'reel 1', metaAdId: '120302' },
    { _id: 'a3', name: 'Static', metaAdId: '' },
  ];
  assert.deepEqual(adMatchOf({ name: 'Reel 1', metaId: '' }, ads), { ad: null, ambiguous: true });
  assert.equal(adMatchOf({ name: 'Reel 1', metaId: '120302' }, ads).ad._id, 'a2', 'the ID tells them apart');
  assert.equal(adMatchOf({ name: 'static', metaId: '' }, ads).ad._id, 'a3');
  assert.deepEqual(adMatchOf({ name: 'New reel', metaId: '' }, ads), { ad: null }, 'a new ad');
  assert.equal(matchImportAd({ name: 'Reel 1', metaId: '' }, ads), null);
});

test('an ad-level import: each row needs an ad (name or Meta ad ID); ads are grouped per campaign with their days', () => {
  const base = { campaign: 'Bridal', campaignId: '120201', day: '2026-11-02', spend: 100, reach: 500, impressions: 1000, clicks: 20, results: 2 };
  const v = cleanImportInput({ level: 'ad', rows: [
    { ...base, ad: 'Reel 1', adId: '120301', adSet: 'Brides 22–35', adSetId: '120401' },
    { ...base, ad: 'Reel 1', adId: '120301', day: '2026-11-03', spend: 50.5 },
    { ...base, ad: 'Static', adId: '' },
    { ...base, ad: '', adId: '' },
    { ...base, ad: 'Bad id', adId: 'has space' },
  ] }, { today: '2026-11-13' });
  assert.equal(v.ok, true);
  assert.equal(v.value.level, 'ad');
  assert.deepEqual(v.value.skipped.map((x) => x.reason), ['No ad name or ad ID.', 'The ad ID is not valid.']);
  const [g] = groupImportRows(v.value.rows);
  assert.equal(g.ads.size, 2);
  const reel = g.ads.get('id:120301');
  assert.deepEqual([reel.name, reel.adSetName, reel.adSetId, reel.days.size, reel.days.get('2026-11-03').spend], ['Reel 1', 'Brides 22–35', '120401', 2, 50.5]);
  assert.equal(g.days.get('2026-11-02').spend, 200, 'the campaign\'s day adds its ads');
  assert.equal(cleanImportInput({ level: 'pixels', rows: [base] }).ok, false);
  assert.equal(cleanImportInput({ rows: [base] }).value.level, 'campaign', 'no level = one row per campaign per day, as before');
});

test('a breakdown import: age / gender / platform + position; the same segment of a day is added; a row with none is skipped', () => {
  const base = { campaign: 'Bridal', day: '2026-11-02', spend: 100, impressions: 1000, clicks: 10, results: 1 };
  const v = cleanImportInput({ level: 'breakdown', rows: [
    { ...base, age: '25-34', gender: 'female' },
    { ...base, age: '25-34', gender: 'female', spend: 50 },
    { ...base, age: '35-44', gender: 'female' },
    { ...base, platform: 'Instagram', position: 'Reels' },
    { ...base },
  ] }, { today: '2026-11-13' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.skipped.map((x) => x.reason), ['No age, gender or placement.']);
  assert.deepEqual(v.value.rows.map((r) => r.dimension), ['age+gender', 'age+gender', 'age+gender', 'placement']);
  assert.equal(v.value.rows[3].placement, 'Instagram · Reels');
  const [g] = groupImportRows(v.value.rows);
  assert.equal(g.segments.size, 3);
  assert.equal(g.segments.get('2026-11-02|age+gender|25-34|female|').spend, 150);
});

test('an ad of the file is found by its Meta ad ID, else by its exact name in the campaign; a shared name is not guessed', () => {
  const have = [{ _id: 'a1', name: 'Reel 1', metaAdId: '901' }, { _id: 'a2', name: 'Static', metaAdId: '' }, { _id: 'a3', name: 'Twin', metaAdId: '' }, { _id: 'a4', name: 'twin', metaAdId: '' }];
  assert.equal(matchImportAd({ name: 'Renamed in Meta', metaId: '901' }, have)._id, 'a1');
  assert.equal(matchImportAd({ name: 'static', metaId: '' }, have)._id, 'a2');
  assert.equal(matchImportAd({ name: 'static', metaId: '777' }, have)._id, 'a2', 'a typed ad with no Meta ID is adopted by name');
  assert.equal(matchImportAd({ name: 'Reel 1', metaId: '555' }, have), null, 'a different Meta ID is a different ad, even with the same name');
  assert.equal(matchImportAd({ name: 'TWIN', metaId: '' }, have), null);
  assert.equal(matchImportAd({ name: '', metaId: '' }, have), null);
});
