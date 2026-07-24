/**
 * Seeds sample competitor-intelligence data so the Weekly Growth Score board,
 * leaderboards and trends have something to show.
 *
 * Creates ~8 makeup-studio competitors across Kerala and 4 weeks of scored
 * weekly snapshots each, with signals, evidence and reel/post links. Scores are
 * computed with the SAME logic and weights the app uses, so the seeded board is
 * identical to what manual entry would produce.
 *
 * Usage:
 *   node scripts/seedMarketing.js            # dry run — prints a preview
 *   node scripts/seedMarketing.js --apply    # write to the database
 *   node scripts/seedMarketing.js --apply --wipe   # clear seeded data first
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Competitor from '../models/Competitor.js';
import CompetitorSnapshot from '../models/CompetitorSnapshot.js';
import ScoringConfig from '../models/ScoringConfig.js';

const APPLY = process.argv.includes('--apply');
const WIPE = process.argv.includes('--wipe');

// Mirrors marketingController scoring (SRS §4.2).
const WEIGHTS = {
  newCampaign: 5,
  viralContent: 5,
  qualityCreative: 5,
  followerGrowth: 3,
  engagementIncrease: 3,
  newService: 2,
  newPartnership: 2,
};
const LABELS = {
  newCampaign: 'New Campaign',
  viralContent: 'Viral Content',
  qualityCreative: 'Quality Creative',
  followerGrowth: 'Follower Growth',
  engagementIncrease: 'Engagement Increase',
  newService: 'New Service',
  newPartnership: 'New Partnership',
};
const KEYS = Object.keys(WEIGHTS);

const computeScoreAndSignals = (flags, evidence, links) => {
  const signals = [];
  let total = 0;
  for (const key of KEYS) {
    if (flags[key]) {
      const points = WEIGHTS[key];
      total += points;
      signals.push({
        key,
        label: LABELS[key],
        points,
        evidence: evidence[key] || '',
        link: links[key] || '',
      });
    }
  }
  return { score: Math.max(1, Math.min(25, total)), signals };
};

// Monday 00:00 UTC of the week that is `weeksAgo` before this week.
const mondayWeeksAgo = (weeksAgo) => {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  );
  monday.setUTCDate(monday.getUTCDate() - weeksAgo * 7);
  return monday;
};

const SEED_NOTE = 'seed:sample';

// Eight competitors with a realistic spread of momentum.
const COMPETITORS = [
  { name: 'Glamour Studio Kochi', city: 'Kochi', category: 'Bridal', instagram: 'glamourstudiokochi', hot: true },
  { name: 'Blush Bridal Calicut', city: 'Kozhikode', category: 'Bridal', instagram: 'blushbridalcalicut', hot: true },
  { name: 'Radiance Makeovers', city: 'Thrissur', category: 'Bridal', instagram: 'radiancemakeovers' },
  { name: 'Kohl & Co', city: 'Trivandrum', category: 'Party', instagram: 'kohlandco' },
  { name: 'Ivory Looks', city: 'Kannur', category: 'Bridal', instagram: 'ivorylooks' },
  { name: 'Studio Nova', city: 'Kochi', category: 'Editorial', instagram: 'studionova' },
  { name: 'Petal & Powder', city: 'Kozhikode', category: 'Party', instagram: 'petalandpowder' },
  { name: 'The Bridal Room', city: 'Thrissur', category: 'Bridal', instagram: 'thebridalroom' },
];

// Per-week signal profile per competitor index — designed so scores rise, fall
// and hold, producing real movement / trends / leaderboards. Week 0 = oldest.
// Each entry: which signal keys fire that week.
const SIGNAL_PLAN = [
  // Glamour — steady climber (viral streak)
  [['followerGrowth'], ['viralContent', 'followerGrowth'], ['viralContent', 'qualityCreative', 'followerGrowth'], ['newCampaign', 'viralContent', 'qualityCreative', 'followerGrowth', 'engagementIncrease']],
  // Blush — big spike then holds high
  [['engagementIncrease'], ['newCampaign', 'qualityCreative'], ['newCampaign', 'viralContent', 'qualityCreative', 'newPartnership'], ['viralContent', 'qualityCreative', 'newPartnership', 'followerGrowth']],
  // Radiance — mid, occasional
  [['newService'], ['followerGrowth'], ['qualityCreative'], ['viralContent', 'newService']],
  // Kohl — declining
  [['newCampaign', 'viralContent', 'qualityCreative'], ['viralContent', 'qualityCreative'], ['followerGrowth'], []],
  // Ivory — low and flat
  [[], ['newService'], [], ['engagementIncrease']],
  // Nova — riser (editorial quality)
  [['qualityCreative'], ['qualityCreative', 'engagementIncrease'], ['qualityCreative', 'viralContent'], ['qualityCreative', 'viralContent', 'newCampaign', 'newPartnership']],
  // Petal — bursty
  [['viralContent'], [], ['newCampaign', 'newPartnership'], ['viralContent']],
  // Bridal Room — steady mid
  [['followerGrowth'], ['followerGrowth', 'newService'], ['qualityCreative'], ['followerGrowth', 'qualityCreative']],
];

const EVIDENCE = {
  newCampaign: 'New Reel-ad set launched this week',
  viralContent: 'Bridal reel hit 5.8x their 8-week median',
  qualityCreative: 'AI creative score 9/10 — clean edit, strong hook',
  followerGrowth: '+4.2% followers WoW',
  engagementIncrease: 'Engagement rate up 27% WoW',
  newService: 'Added "HD Airbrush" package page',
  newPartnership: 'Tagged influencer @keralabride',
};
const LINKS = {
  viralContent: 'https://www.instagram.com/reel/DExampleViral/',
  qualityCreative: 'https://www.instagram.com/reel/DExampleQuality/',
  newCampaign: 'https://www.facebook.com/ads/library/?id=000000000',
};

const round = (v) => Math.round(v * 10) / 10;

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}${WIPE ? ' + WIPE' : ''}\n`);

  if (WIPE && APPLY) {
    const seeded = await Competitor.find({ notes: SEED_NOTE }, '_id');
    const ids = seeded.map((c) => c._id);
    await CompetitorSnapshot.deleteMany({ competitor: { $in: ids } });
    await Competitor.deleteMany({ notes: SEED_NOTE });
    console.log(`Wiped ${ids.length} previously seeded competitors.\n`);
  }

  // Ensure an active scoring config exists so the app's compute matches.
  if (APPLY && !(await ScoringConfig.findOne({ active: true }))) {
    await ScoringConfig.create({ version: 1, weights: WEIGHTS, active: true, note: 'seed default' });
    console.log('Created default ScoringConfig v1.\n');
  }

  const weeks = [mondayWeeksAgo(3), mondayWeeksAgo(2), mondayWeeksAgo(1), mondayWeeksAgo(0)];
  let competitorsWritten = 0;
  let snapshotsWritten = 0;
  const preview = [];

  for (let i = 0; i < COMPETITORS.length; i++) {
    const def = COMPETITORS[i];
    let competitor = await Competitor.findOne({ name: def.name, city: def.city });
    if (!competitor) {
      const doc = {
        name: def.name,
        city: def.city,
        category: def.category,
        website: `https://${def.instagram}.example.com`,
        instagram: def.instagram,
        active: true,
        notes: SEED_NOTE,
      };
      if (APPLY) competitor = await Competitor.create(doc);
      competitorsWritten++;
    }

    let followers = 8000 + i * 2500; // starting base varies by competitor
    const plan = SIGNAL_PLAN[i];

    for (let w = 0; w < weeks.length; w++) {
      const fired = plan[w] || [];
      const flags = Object.fromEntries(KEYS.map((k) => [k, fired.includes(k)]));
      const evidence = Object.fromEntries(fired.map((k) => [k, EVIDENCE[k] || '']));
      const links = Object.fromEntries(fired.filter((k) => LINKS[k]).map((k) => [k, LINKS[k]]));
      const { score, signals } = computeScoreAndSignals(flags, evidence, links);

      const growthPct = flags.followerGrowth ? round(3 + Math.random() * 3) : round(Math.random() * 2);
      followers = Math.round(followers * (1 + growthPct / 100));
      const engagementRate = round(2 + (flags.engagementIncrease ? 2.5 : 0) + Math.random() * 1.5);

      const snap = {
        competitor: competitor?._id,
        weekOf: weeks[w],
        followers,
        weeklyGrowthPct: growthPct,
        engagementRate,
        adCampaigns: flags.newCampaign ? 1 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 2),
        offers: Math.floor(Math.random() * 3),
        newServicesCount: flags.newService ? 1 : 0,
        postingFrequency: 3 + Math.floor(Math.random() * 5),
        seoScore: round(40 + i * 4 + Math.random() * 10),
        reviews: 20 + i * 8 + w * 3,
        collaborations: flags.newPartnership ? 1 + Math.floor(Math.random() * 2) : Math.floor(Math.random() * 2),
        contentThemes: def.category,
        ...flags,
        signalEvidence: evidence,
        signalLinks: links,
        signals,
        scoringVersion: 1,
        score,
        notes: SEED_NOTE,
      };

      if (APPLY && competitor) {
        await CompetitorSnapshot.findOneAndUpdate(
          { competitor: competitor._id, weekOf: weeks[w] },
          snap,
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
      snapshotsWritten++;
      if (w === weeks.length - 1) {
        preview.push(`  ${def.name.padEnd(24)} ${def.city.padEnd(12)} latest GS ${String(score).padStart(2)}  (${fired.join(', ') || 'no signals'})`);
      }
    }
  }

  console.log('Latest-week score preview:');
  console.log(preview.join('\n'));
  console.log('\n──────── Summary ────────');
  console.log(`Weeks seeded        : ${weeks.map((d) => d.toISOString().slice(0, 10)).join(', ')}`);
  console.log(`Competitors         : ${COMPETITORS.length} (${competitorsWritten} new)`);
  console.log(`Snapshots           : ${snapshotsWritten}`);
  console.log(APPLY ? '\nWritten to database.' : '\nDRY RUN — nothing written. Re-run with --apply.');

  await mongoose.disconnect();
};

run().catch(async (e) => {
  console.error('Seed failed:', e);
  await mongoose.disconnect();
  process.exit(1);
});
