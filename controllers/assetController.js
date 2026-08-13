import Asset, { ASSET_TYPES, ASSET_STATUSES, DEPRECIATION_METHODS } from '../models/Asset.js';

// Finance section is management + accounts territory.
const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const cleanAsset = (body) => {
  const assetType = ASSET_TYPES.includes(body.assetType) ? body.assetType : 'physical';
  const status = ASSET_STATUSES.includes(body.status) ? body.status : 'active';
  return {
    name: String(body.name ?? '').trim(),
    assetType,
    category: String(body.category ?? 'other').trim() || 'other',
    value: Math.max(0, Number(body.value) || 0),
    quantity: Math.max(0, Number.parseInt(body.quantity, 10) || 1),
    purchaseDate: toDate(body.purchaseDate),
    status,
    custodian: String(body.custodian ?? '').trim(),
    custodianEmployeeId:
      body.custodianEmployeeId && String(body.custodianEmployeeId).length === 24
        ? body.custodianEmployeeId
        : null,
    location: String(body.location ?? '').trim(),
    condition: String(body.condition ?? '').trim(),
    serialNumber: String(body.serialNumber ?? '').trim(),
    imageUrl: String(body.imageUrl ?? '').trim(),
    provider: String(body.provider ?? '').trim(),
    url: String(body.url ?? '').trim(),
    expiryDate: toDate(body.expiryDate),
    notes: String(body.notes ?? '').trim(),
    // Depreciation config (accumulated / lastDepreciatedOn are engine-owned and
    // deliberately not settable here, so an edit never resets them).
    depreciable: body.depreciable === true || body.depreciable === 'true',
    depreciationMethod: DEPRECIATION_METHODS.includes(body.depreciationMethod)
      ? body.depreciationMethod
      : 'straight_line',
    depreciationRate: Math.min(100, Math.max(0, Number(body.depreciationRate) || 0)),
    usefulLifeYears: Math.max(0, Number(body.usefulLifeYears) || 0),
    salvageValue: Math.max(0, Number(body.salvageValue) || 0),
    depreciationStart: toDate(body.depreciationStart),
  };
};

// @desc    List assets (optional type / status / category / search filters)
// @route   GET /api/assets
// @access  Private (finance roles)
export const getAssets = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const { type, status, category, search } = req.query;
    const query = {};
    if (type && ASSET_TYPES.includes(type)) query.assetType = type;
    if (status && status !== 'all') query.status = status;
    if (category && category !== 'all') query.category = category;
    if (search) {
      const rx = new RegExp(search, 'i');
      query.$or = [
        { name: rx },
        { provider: rx },
        { location: rx },
        { serialNumber: rx },
        { custodian: rx },
        { notes: rx },
      ];
    }
    const assets = await Asset.find(query)
      .populate('custodianEmployeeId', 'name')
      .sort({ createdAt: -1 });
    res.json(assets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Portfolio stats for the Finance dashboard
// @route   GET /api/assets/stats
// @access  Private (finance roles)
export const getAssetStats = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const assets = await Asset.find({}).lean();
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const stats = {
      totalCount: assets.length,
      totalValue: 0,
      digital: { count: 0, value: 0 },
      physical: { count: 0, value: 0 },
      byCategory: {}, // category -> { count, value }
      byStatus: {}, // status -> count
      upcomingRenewals: 0, // digital assets expiring within 30 days
      expired: 0,
    };

    for (const a of assets) {
      const val = (Number(a.value) || 0) * (Number(a.quantity) || 1);
      stats.totalValue += val;
      const bucket = a.assetType === 'digital' ? stats.digital : stats.physical;
      bucket.count += 1;
      bucket.value += val;

      const cat = a.category || 'other';
      stats.byCategory[cat] = stats.byCategory[cat] || { count: 0, value: 0 };
      stats.byCategory[cat].count += 1;
      stats.byCategory[cat].value += val;

      const st = a.status || 'active';
      stats.byStatus[st] = (stats.byStatus[st] || 0) + 1;

      if (a.expiryDate) {
        const exp = new Date(a.expiryDate);
        if (exp < now) stats.expired += 1;
        else if (exp <= soon) stats.upcomingRenewals += 1;
      }
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create an asset
// @route   POST /api/assets
// @access  Private (finance roles)
export const createAsset = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const data = cleanAsset(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Asset name is required' });
    }
    const asset = await Asset.create({ ...data, createdBy: req.user?._id || null });
    const populated = await asset.populate('custodianEmployeeId', 'name');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update an asset
// @route   PUT /api/assets/:id
// @access  Private (finance roles)
export const updateAsset = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    const data = cleanAsset({ ...asset.toObject(), ...req.body });
    Object.assign(asset, data);
    await asset.save();
    const populated = await asset.populate('custodianEmployeeId', 'name');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete an asset
// @route   DELETE /api/assets/:id
// @access  Private (finance roles)
export const deleteAsset = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const asset = await Asset.findById(req.params.id);
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    await asset.deleteOne();
    res.json({ message: 'Asset removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
