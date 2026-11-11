import mongoose from 'mongoose';

// ── 1. Activity Group Master (mkt_group) ───────────────────────────────────
const marketingGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ── 2. Role Master (mkt_role) ──────────────────────────────────────────────
const marketingRoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ── 3. Team Member Master (mkt_team_member) ────────────────────────────────
const marketingTeamMemberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, trim: true },
    shortName: { type: String, required: true, trim: true }, // e.g. "Ashique", "Saeeda"
    activeFrom: { type: Date, default: Date.now },
    activeTo: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// ── 4. Member Role History (mkt_member_role) ───────────────────────────────
const marketingMemberRoleSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingRole', required: true },
    fromMonth: { type: String, required: true }, // YYYY-MM
  },
  { timestamps: true }
);
marketingMemberRoleSchema.index({ memberId: 1, fromMonth: 1 });

// ── 5. Metric Catalogue (mkt_metric) ───────────────────────────────────────
const marketingMetricSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingGroup', required: true },
    code: { type: Number, required: true, unique: true }, // 1..21 canonical number
    name: { type: String, required: true, trim: true },
    unitType: { type: String, enum: ['count', 'currency'], default: 'count' },
    inTotalOutput: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    // FR-6: soft-warning ceiling for one day's count (null = no ceiling).
    maxPerDay: { type: Number, default: null },
  },
  { timestamps: true }
);

// ── 6. Role Profile / Template (mkt_role_metric) ───────────────────────────
const marketingRoleMetricSchema = new mongoose.Schema(
  {
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingRole', required: true },
    metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
  },
  { timestamps: true }
);
marketingRoleMetricSchema.index({ roleId: 1, metricId: 1 }, { unique: true });

// ── 7. Member Activity Set by Month (mkt_member_metric) ────────────────────
const marketingMemberMetricSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
    fromMonth: { type: String, required: true }, // YYYY-MM
    toMonth: { type: String, default: null },    // YYYY-MM or null if indefinite
  },
  { timestamps: true }
);
marketingMemberMetricSchema.index({ memberId: 1, metricId: 1, fromMonth: 1 });

// ── 8. Monthly Targets (mkt_target) ────────────────────────────────────────
const marketingTargetSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
    month: { type: String, required: true }, // YYYY-MM
    targetValue: { type: Number, default: null }, // null = tracked with no target
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    setAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
marketingTargetSchema.index({ memberId: 1, metricId: 1, month: 1 }, { unique: true });

// ── 9. Working Calendar Settings (mkt_calendar_setting) ────────────────────
const marketingCalendarSettingSchema = new mongoose.Schema(
  {
    weeklyOff: { type: Number, default: 0 }, // 0 = Sunday
    standardHours: { type: Number, default: 8 },
    effectiveFrom: { type: String, default: '2026-01-01' },
    // Open item 12.2: days back a member may edit their own EOD.
    editWindowDays: { type: Number, default: 2, min: 0 },
    // FR-11: HH:mm (IST) at which members who haven't filed are reminded.
    reminderTime: { type: String, default: '19:00' },
  },
  { timestamps: true }
);

// ── 10. Daily EOD Entry & Metric Values (mkt_eod_entry & mkt_eod_value) ────
const marketingEodEntrySchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    entryDate: { type: String, required: true }, // YYYY-MM-DD
    hoursWorked: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', trim: true },
    checkStatus: { type: String, enum: ['OK', 'WARNING'], default: 'OK' },
    checkMessage: { type: String, default: '' },
    values: [
      {
        metricId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingMetric', required: true },
        value: { type: Number, default: 0 },
      },
    ],
    submittedAt: { type: Date, default: Date.now },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
marketingEodEntrySchema.index({ memberId: 1, entryDate: 1 }, { unique: true });

// ── 11. Weekly Page Performance Stats (mkt_weekly_page_stat - FR-18) ────────
const marketingWeeklyPageStatSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    month: { type: String, required: true }, // YYYY-MM
    weekBlock: { type: String, enum: ['W1', 'W2', 'W3', 'W4', 'W5'], required: true },
    page: { type: String, enum: ['makeovers', 'kerala'], required: true },
    postsPublished: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    engagement: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastEditedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
marketingWeeklyPageStatSchema.index(
  { memberId: 1, month: 1, weekBlock: 1, page: 1 },
  { unique: true }
);

// ── 12. Monthly Remarks & Sign-off (mkt_dashboard_remark - FR-12) ──────────
const marketingDashboardRemarkSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', required: true },
    month: { type: String, required: true }, // YYYY-MM
    highlights: { type: String, default: '' },
    managerRemarks: { type: String, default: '' },
    published: { type: Boolean, default: false },
    memberAckAt: { type: Date, default: null },
    managerSignedAt: { type: Date, default: null },
    managerSignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    monthStatus: { type: String, enum: ['open', 'closed'], default: 'open' },
  },
  { timestamps: true }
);
marketingDashboardRemarkSchema.index({ memberId: 1, month: 1 }, { unique: true });

// ── 13. Audit Log (mkt_audit_log - FR-15) ──────────────────────────────────
const marketingAuditLogSchema = new mongoose.Schema(
  {
    table: { type: String, required: true },
    recordId: { type: String, required: true },
    field: { type: String, default: '' },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
);

// ── 14. Performance Status Thresholds (mkt_threshold) ──────────────────────
const marketingThresholdSchema = new mongoose.Schema(
  {
    metricScope: { type: String, default: 'default', unique: true },
    greenMin: { type: Number, default: 100 },
    amberMin: { type: Number, default: 70 },
  },
  { timestamps: true }
);

export const MarketingGroup = mongoose.model('MarketingGroup', marketingGroupSchema);
export const MarketingRole = mongoose.model('MarketingRole', marketingRoleSchema);
export const MarketingTeamMember = mongoose.model('MarketingTeamMember', marketingTeamMemberSchema);
export const MarketingMemberRole = mongoose.model('MarketingMemberRole', marketingMemberRoleSchema);
export const MarketingMetric = mongoose.model('MarketingMetric', marketingMetricSchema);
export const MarketingRoleMetric = mongoose.model('MarketingRoleMetric', marketingRoleMetricSchema);
export const MarketingMemberMetric = mongoose.model('MarketingMemberMetric', marketingMemberMetricSchema);
export const MarketingTarget = mongoose.model('MarketingTarget', marketingTargetSchema);
export const MarketingCalendarSetting = mongoose.model('MarketingCalendarSetting', marketingCalendarSettingSchema);
export const MarketingEodEntry = mongoose.model('MarketingEodEntry', marketingEodEntrySchema);
export const MarketingWeeklyPageStat = mongoose.model('MarketingWeeklyPageStat', marketingWeeklyPageStatSchema);
export const MarketingDashboardRemark = mongoose.model('MarketingDashboardRemark', marketingDashboardRemarkSchema);
export const MarketingAuditLog = mongoose.model('MarketingAuditLog', marketingAuditLogSchema);
export const MarketingThreshold = mongoose.model('MarketingThreshold', marketingThresholdSchema);
