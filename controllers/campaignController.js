import Campaign from '../models/Campaign.js';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';

const MARKETING_ROLES = ['admin', 'manager', 'marketing_admin'];
const DEAD_BOOKING = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const READ_ROLES = [...MARKETING_ROLES, 'accounts', 'crm'];
const canManage = (u) => MARKETING_ROLES.includes(u?.role);
const canRead = (u) => READ_ROLES.includes(u?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Derive the cost/return ratios for one campaign.
const withMetrics = (c) => {
  const adSpend = Number(c.adSpend) || 0;
  const productionCost = Number(c.productionCost) || 0;
  const revenue = Number(c.revenue) || 0;
  const totalCost = round2(adSpend + productionCost);
  const leads = Number(c.leads) || 0;
  const conversions = Number(c.conversions) || 0;
  return {
    ...c,
    totalCost,
    profit: round2(revenue - totalCost),
    roiPct: totalCost > 0 ? round2(((revenue - totalCost) / totalCost) * 100) : null,
    roas: adSpend > 0 ? round2(revenue / adSpend) : null,
    costPerLead: leads > 0 ? round2(totalCost / leads) : null,
    costPerAcquisition: conversions > 0 ? round2(totalCost / conversions) : null,
  };
};

// @route GET /api/marketing/campaigns?status=&from=&to=
export const getCampaigns = async (req, res) => {
  try {
    if (!canRead(req.user)) return res.status(403).json({ message: 'No marketing access' });
    const { status, from, to } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    if (from || to) {
      filter.startDate = {};
      if (from) filter.startDate.$gte = new Date(from);
      if (to) filter.startDate.$lte = new Date(to);
    }
    const docs = await Campaign.find(filter).sort({ startDate: -1, createdAt: -1 }).lean();

    // ── Auto revenue attribution ──
    // Leads tagged with a campaign → the revenue of their bookings rolls up to
    // that campaign. Manual revenue/leads/conversions (when set) override this.
    const taggedLeads = await Lead.find({ campaignId: { $ne: null } })
      .select('_id campaignId').lean();
    const leadToCampaign = new Map(taggedLeads.map((l) => [String(l._id), String(l.campaignId)]));
    const auto = new Map(); // campaignId -> { leads, conversions, revenue }
    const bump = (cid) => {
      const a = auto.get(cid) || { leads: 0, conversions: 0, revenue: 0 };
      auto.set(cid, a);
      return a;
    };
    for (const l of taggedLeads) bump(String(l.campaignId)).leads += 1;

    if (taggedLeads.length) {
      const bookings = await Booking.find({
        leadId: { $in: taggedLeads.map((l) => l._id) },
        status: { $nin: DEAD_BOOKING },
      }).select('leadId totalPrice').lean();
      for (const b of bookings) {
        const cid = leadToCampaign.get(String(b.leadId));
        if (!cid) continue;
        const a = bump(cid);
        a.revenue += Number(b.totalPrice) || 0;
        a.conversions += 1;
      }
    }

    const campaigns = docs.map((c) => {
      const a = auto.get(String(c._id)) || { leads: 0, conversions: 0, revenue: 0 };
      // Manual value wins when > 0; otherwise use the attributed figure.
      const revenue = (c.revenue || 0) > 0 ? c.revenue : round2(a.revenue);
      const leads = (c.leads || 0) > 0 ? c.leads : a.leads;
      const conversions = (c.conversions || 0) > 0 ? c.conversions : a.conversions;
      return withMetrics({
        ...c,
        revenue,
        leads,
        conversions,
        autoRevenue: round2(a.revenue),
        autoLeads: a.leads,
        autoConversions: a.conversions,
        autoAttributed: (c.revenue || 0) <= 0 && a.revenue > 0,
      });
    });

    const totalAdSpend = round2(campaigns.reduce((s, c) => s + (c.adSpend || 0), 0));
    const totalProductionCost = round2(campaigns.reduce((s, c) => s + (c.productionCost || 0), 0));
    const totalCost = round2(totalAdSpend + totalProductionCost);
    const totalRevenue = round2(campaigns.reduce((s, c) => s + (c.revenue || 0), 0));
    const summary = {
      count: campaigns.length,
      totalAdSpend,
      totalProductionCost,
      totalCost,
      totalRevenue,
      blendedRoiPct: totalCost > 0 ? round2(((totalRevenue - totalCost) / totalCost) * 100) : null,
      blendedRoas: totalAdSpend > 0 ? round2(totalRevenue / totalAdSpend) : null,
    };
    res.json({ campaigns, summary });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const clean = (b) => ({
  title: String(b.title ?? '').trim(),
  channel: String(b.channel ?? '').trim(),
  status: ['planned', 'active', 'paused', 'completed'].includes(b.status) ? b.status : 'active',
  startDate: b.startDate ? new Date(b.startDate) : null,
  endDate: b.endDate ? new Date(b.endDate) : null,
  adSpend: Math.max(0, Number(b.adSpend) || 0),
  productionCost: Math.max(0, Number(b.productionCost) || 0),
  revenue: Math.max(0, Number(b.revenue) || 0),
  leads: Math.max(0, Number(b.leads) || 0),
  conversions: Math.max(0, Number(b.conversions) || 0),
  notes: String(b.notes ?? '').trim(),
});

// @route POST /api/marketing/campaigns
export const createCampaign = async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ message: 'Not authorized' });
    const data = clean(req.body);
    if (!data.title) return res.status(400).json({ message: 'A campaign title is required.' });
    const doc = await Campaign.create({ ...data, createdBy: req.user?._id ?? null });
    res.status(201).json(withMetrics(doc.toObject()));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/marketing/campaigns/:id
export const updateCampaign = async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ message: 'Not authorized' });
    const data = clean(req.body);
    if (!data.title) return res.status(400).json({ message: 'A campaign title is required.' });
    const doc = await Campaign.findByIdAndUpdate(req.params.id, { $set: data }, { new: true }).lean();
    if (!doc) return res.status(404).json({ message: 'Campaign not found' });
    res.json(withMetrics(doc));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/marketing/campaigns/:id
export const deleteCampaign = async (req, res) => {
  try {
    if (!canManage(req.user)) return res.status(403).json({ message: 'Not authorized' });
    const doc = await Campaign.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Campaign not found' });
    res.json({ message: 'Campaign removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
