import District from '../models/District.js';

export const getDistricts = async (req, res) => {
  try {
    const query = req.query.active === 'true' ? { status: 'active' } : {};
    if (req.query.regionId) {
      query.region = req.query.regionId;
    }

    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        District.find(query)
          .populate({ path: 'region', populate: { path: 'state', populate: { path: 'zone' } } })
          .sort({ name: 1 })
          .skip(skip)
          .limit(currentLimit),
        District.countDocuments(query),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const districts = await District.find(query)
      .populate({ path: 'region', populate: { path: 'state', populate: { path: 'zone' } } })
      .sort({ name: 1 });
    res.json(districts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getDistrictById = async (req, res) => {
  try {
    const district = await District.findById(req.params.id)
      .populate({ path: 'region', populate: { path: 'state', populate: { path: 'zone' } } });
    if (!district) {
      return res.status(404).json({ message: 'District not found' });
    }
    res.json(district);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveDistrict = async (req, res) => {
  const { id, name, regionId, status } = req.body;

  try {
    let district;
    if (id) {
      district = await District.findById(id);
      if (!district) {
        return res.status(404).json({ message: 'District not found' });
      }
      district.name = name ?? district.name;
      district.region = regionId ?? district.region;
      district.status = status ?? district.status;
      await district.save();
    } else {
      district = await District.create({
        name,
        region: regionId,
        status: status ?? 'active',
      });
    }
    const populatedDistrict = await District.findById(district._id)
      .populate({ path: 'region', populate: { path: 'state', populate: { path: 'zone' } } });
    res.status(id ? 200 : 201).json(populatedDistrict);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteDistrict = async (req, res) => {
  try {
    const district = await District.findById(req.params.id);
    if (!district) {
      return res.status(404).json({ message: 'District not found' });
    }
    await district.deleteOne();
    res.json({ message: 'District removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
