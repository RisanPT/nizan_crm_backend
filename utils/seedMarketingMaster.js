import {
  MarketingGroup,
  MarketingRole,
  MarketingMetric,
  MarketingRoleMetric,
  MarketingTeamMember,
  MarketingMemberRole,
  MarketingMemberMetric,
  MarketingCalendarSetting,
  MarketingThreshold,
} from '../models/MarketingEod.js';
import User from '../models/User.js';

export const seedMarketingMasterData = async () => {
  try {
    // ── 1. Seed Groups ───────────────────────────────────────────────────────
    const groupDefs = [
      { name: 'Production', sortOrder: 1 },
      { name: 'Posting', sortOrder: 2 },
      { name: 'Ads', sortOrder: 3 },
      { name: 'Coordination', sortOrder: 4 },
      { name: 'Community', sortOrder: 5 },
    ];

    const groupMap = {};
    for (const g of groupDefs) {
      let group = await MarketingGroup.findOne({ name: g.name });
      if (!group) {
        group = await MarketingGroup.create(g);
      }
      groupMap[g.name] = group._id;
    }

    // ── 2. Seed 21 Metrics ───────────────────────────────────────────────────
    const metricDefs = [
      // Production
      { group: 'Production', code: 1, name: 'Shoots done', unitType: 'count', inTotalOutput: true, sortOrder: 1 },
      { group: 'Production', code: 2, name: 'Reels / videos edited', unitType: 'count', inTotalOutput: true, sortOrder: 2 },
      { group: 'Production', code: 3, name: 'Story / short edits', unitType: 'count', inTotalOutput: true, sortOrder: 3 },
      { group: 'Production', code: 4, name: 'Creatives designed', unitType: 'count', inTotalOutput: true, sortOrder: 4 },
      // Posting
      { group: 'Posting', code: 5, name: 'Reels posted', unitType: 'count', inTotalOutput: true, sortOrder: 5 },
      { group: 'Posting', code: 6, name: 'Stories posted', unitType: 'count', inTotalOutput: true, sortOrder: 6 },
      { group: 'Posting', code: 7, name: 'Feed / carousel posts', unitType: 'count', inTotalOutput: true, sortOrder: 7 },
      { group: 'Posting', code: 8, name: 'Collab posts', unitType: 'count', inTotalOutput: true, sortOrder: 8 },
      { group: 'Posting', code: 18, name: 'Posts on other platforms (Snapchat, Pinterest, YouTube)', unitType: 'count', inTotalOutput: true, sortOrder: 9 },
      // Ads
      { group: 'Ads', code: 9, name: 'Campaigns launched', unitType: 'count', inTotalOutput: true, sortOrder: 10 },
      { group: 'Ads', code: 10, name: 'Ad creatives launched', unitType: 'count', inTotalOutput: true, sortOrder: 11 },
      { group: 'Ads', code: 11, name: 'Ad spend (₹)', unitType: 'currency', inTotalOutput: false, sortOrder: 12 },
      { group: 'Ads', code: 12, name: 'Leads from ads', unitType: 'count', inTotalOutput: false, sortOrder: 13 },
      // Coordination
      { group: 'Coordination', code: 13, name: 'Portfolios prepared', unitType: 'count', inTotalOutput: true, sortOrder: 14 },
      { group: 'Coordination', code: 14, name: 'Events coordinated', unitType: 'count', inTotalOutput: true, sortOrder: 15 },
      { group: 'Coordination', code: 15, name: 'Collab / partner outreach', unitType: 'count', inTotalOutput: true, sortOrder: 16 },
      { group: 'Coordination', code: 16, name: 'Meetings held', unitType: 'count', inTotalOutput: false, sortOrder: 17 },
      { group: 'Coordination', code: 17, name: 'Reports prepared', unitType: 'count', inTotalOutput: true, sortOrder: 18 },
      { group: 'Coordination', code: 19, name: 'Videos scheduled to editors', unitType: 'count', inTotalOutput: true, sortOrder: 19 },
      // Community
      { group: 'Community', code: 20, name: 'Enquiries passed to Sales', unitType: 'count', inTotalOutput: false, sortOrder: 20 },
      { group: 'Community', code: 21, name: 'Content calendar gaps flagged', unitType: 'count', inTotalOutput: false, sortOrder: 21 },
    ];

    const metricMap = {};
    for (const m of metricDefs) {
      let metric = await MarketingMetric.findOne({ code: m.code });
      if (!metric) {
        metric = await MarketingMetric.create({
          groupId: groupMap[m.group],
          code: m.code,
          name: m.name,
          unitType: m.unitType,
          inTotalOutput: m.inTotalOutput,
          sortOrder: m.sortOrder,
          isActive: true,
        });
      }
      metricMap[m.code] = metric._id;
    }

    // ── 3. Seed Roles ────────────────────────────────────────────────────────
    const roleDefs = [
      { name: 'Marketing Manager', sortOrder: 1 },
      { name: 'Marketing Executive', sortOrder: 2 },
      { name: 'Video Editing Head', sortOrder: 3 },
      { name: 'Editor cum Videographer', sortOrder: 4 },
      { name: 'Videographer and Photographer', sortOrder: 5 },
      { name: 'Marketing Intern', sortOrder: 6 },
    ];

    const roleMap = {};
    for (const r of roleDefs) {
      let role = await MarketingRole.findOne({ name: r.name });
      if (!role) {
        role = await MarketingRole.create(r);
      }
      roleMap[r.name] = role._id;
    }

    // ── 4. Seed Role Profiles (mkt_role_metric) ──────────────────────────────
    const roleProfileMappings = [
      { role: 'Marketing Manager', codes: [9, 10, 11, 12, 15, 16, 17] },
      { role: 'Marketing Executive', codes: [4, 13, 14, 15, 16, 17, 19] },
      { role: 'Video Editing Head', codes: [2, 3] },
      { role: 'Editor cum Videographer', codes: [1, 2, 3] },
      { role: 'Videographer and Photographer', codes: [1] },
      { role: 'Marketing Intern', codes: [4, 5, 6, 7, 8, 18, 17, 20, 21] },
    ];

    for (const mapping of roleProfileMappings) {
      const roleId = roleMap[mapping.role];
      if (!roleId) continue;
      for (const code of mapping.codes) {
        const metricId = metricMap[code];
        if (metricId) {
          await MarketingRoleMetric.findOneAndUpdate(
            { roleId, metricId },
            { roleId, metricId },
            { upsert: true }
          );
        }
      }
    }

    // ── 5. Seed Team Members (Section 2.2) ────────────────────────────────────
    const teamDefs = [
      { name: 'Salmanul Faris AT', shortName: 'Salmaan', role: 'Marketing Manager', sortOrder: 1 },
      { name: 'Shahala', shortName: 'Shahala', role: 'Marketing Executive', sortOrder: 2 },
      { name: 'Muhammed Ashique B', shortName: 'Ashique', role: 'Video Editing Head', sortOrder: 3 },
      { name: 'Muhammed Faies', shortName: 'Faies', role: 'Editor cum Videographer', sortOrder: 4 },
      { name: 'Shahada', shortName: 'Shahada', role: 'Videographer and Photographer', sortOrder: 5 },
      { name: 'Saeeda', shortName: 'Saeeda', role: 'Marketing Intern', sortOrder: 6 },
    ];

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    for (const member of teamDefs) {
      let tm = await MarketingTeamMember.findOne({ name: member.name });
      if (!tm) {
        // Try linking to an existing user with similar name
        const linkedUser = await User.findOne({
          name: { $regex: new RegExp(member.shortName, 'i') },
        });
        tm = await MarketingTeamMember.create({
          name: member.name,
          shortName: member.shortName,
          userId: linkedUser?._id || null,
          sortOrder: member.sortOrder,
          activeFrom: new Date('2026-10-01'),
          isActive: true,
        });
      }

      // Member Role History
      const roleId = roleMap[member.role];
      if (roleId) {
        await MarketingMemberRole.findOneAndUpdate(
          { memberId: tm._id, fromMonth: '2026-10' },
          { memberId: tm._id, roleId, fromMonth: '2026-10' },
          { upsert: true }
        );

        // Member Activity Set: populate from role profile for current and past months
        const roleMetrics = await MarketingRoleMetric.find({ roleId });
        for (const rm of roleMetrics) {
          await MarketingMemberMetric.findOneAndUpdate(
            { memberId: tm._id, metricId: rm.metricId, fromMonth: '2026-10' },
            { memberId: tm._id, metricId: rm.metricId, fromMonth: '2026-10', toMonth: null },
            { upsert: true }
          );
        }
      }
    }

    // ── 6. Seed Calendar Settings & Thresholds ───────────────────────────────
    const existingCal = await MarketingCalendarSetting.findOne();
    if (!existingCal) {
      await MarketingCalendarSetting.create({
        weeklyOff: 0, // Sunday
        standardHours: 8,
        effectiveFrom: '2026-01-01',
      });
    }

    const existingThreshold = await MarketingThreshold.findOne({ metricScope: 'default' });
    if (!existingThreshold) {
      await MarketingThreshold.create({
        metricScope: 'default',
        greenMin: 100,
        amberMin: 70,
      });
    }

    console.log('[Marketing EOD] Master data verified & seeded successfully.');
  } catch (err) {
    console.error('[Marketing EOD] Error seeding master data:', err);
  }
};
