import ServicePackage from '../models/Package.js';
import Region from '../models/Region.js';
import District from '../models/District.js';

const normalizeRegionPrices = async (regionPrices = []) => {
  const validRegions = await Region.find({}, '_id');
  const validRegionIds = new Set(validRegions.map((region) => String(region._id)));
  const source = Array.isArray(regionPrices) ? regionPrices : [];

  return source
    .map((item) => ({
      region: String(item.region),
      price: Number(item.price),
    }))
    .filter(
      (item) =>
        validRegionIds.has(item.region) &&
        Number.isFinite(item.price) &&
        item.price >= 0
    )
    .map((item) => ({
      region: item.region,
      price: item.price,
    }));
};

const normalizeDistrictPrices = async (districtPrices = []) => {
  const validDistricts = await District.find({}, '_id');
  const validDistrictIds = new Set(validDistricts.map((d) => String(d._id)));
  const source = Array.isArray(districtPrices) ? districtPrices : [];

  return source
    .map((item) => ({
      district: String(item.district),
      price: Number(item.price),
    }))
    .filter(
      (item) =>
        validDistrictIds.has(item.district) &&
        Number.isFinite(item.price) &&
        item.price >= 0
    )
    .map((item) => ({
      district: item.district,
      price: item.price,
    }));
};

const districtPopulateOption = {
  path: 'districtPrices.district',
  select: 'name status region',
  populate: {
    path: 'region',
    select: 'name status state',
    populate: {
      path: 'state',
      select: 'name status zone',
      populate: {
        path: 'zone',
        select: 'name status',
      },
    },
  },
};

export const getPackages = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        ServicePackage.find({})
          .populate('regionPrices.region', 'name status')
          .populate(districtPopulateOption)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(currentLimit),
        ServicePackage.countDocuments({}),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const packages = await ServicePackage.find({})
      .populate('regionPrices.region', 'name status')
      .populate(districtPopulateOption)
      .sort({ createdAt: -1 });
    res.json(packages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPackageById = async (req, res) => {
  try {
    const servicePackage = await ServicePackage.findById(req.params.id)
      .populate('regionPrices.region', 'name status')
      .populate(districtPopulateOption);
    if (!servicePackage) {
      return res.status(404).json({ message: 'Package not found' });
    }
    res.json(servicePackage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const savePackage = async (req, res) => {
  const {
    id,
    name,
    price,
    advanceAmount,
    description,
    regionPrices = [],
    districtPrices = [],
  } = req.body;

  try {
    const normalizedRegionPrices = await normalizeRegionPrices(regionPrices);
    const normalizedDistrictPrices = await normalizeDistrictPrices(districtPrices);

    let servicePackage;
    if (id) {
      servicePackage = await ServicePackage.findById(id);
      if (!servicePackage) {
        return res.status(404).json({ message: 'Package not found' });
      }

      servicePackage.name = name ?? servicePackage.name;
      servicePackage.price = price ?? servicePackage.price;
      servicePackage.advanceAmount =
        advanceAmount ?? servicePackage.advanceAmount;
      servicePackage.description = description ?? servicePackage.description;
      servicePackage.regionPrices = normalizedRegionPrices;
      servicePackage.districtPrices = normalizedDistrictPrices;
      await servicePackage.save();
    } else {
      servicePackage = await ServicePackage.create({
        name,
        price,
        advanceAmount: advanceAmount ?? 3000,
        description,
        regionPrices: normalizedRegionPrices,
        districtPrices: normalizedDistrictPrices,
      });
    }

    const populatedPackage = await ServicePackage.findById(
      servicePackage._id
    )
      .populate('regionPrices.region', 'name status')
      .populate(districtPopulateOption);

    res.status(id ? 200 : 201).json(populatedPackage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deletePackage = async (req, res) => {
  try {
    const servicePackage = await ServicePackage.findById(req.params.id);
    if (!servicePackage) {
      return res.status(404).json({ message: 'Package not found' });
    }
    await servicePackage.deleteOne();
    res.json({ message: 'Package removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
