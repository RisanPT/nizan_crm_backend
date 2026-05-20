import Zone from '../models/Zone.js';

export const getZones = async (req, res) => {
  try {
    const query = req.query.active === 'true' ? { status: 'active' } : {};
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Zone.find(query).sort({ name: 1 }).skip(skip).limit(currentLimit),
        Zone.countDocuments(query),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const zones = await Zone.find(query).sort({ name: 1 });
    res.json(zones);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getZoneById = async (req, res) => {
  try {
    const zone = await Zone.findById(req.params.id);
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found' });
    }
    res.json(zone);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveZone = async (req, res) => {
  const { id, name, status } = req.body;

  try {
    let zone;
    if (id) {
      zone = await Zone.findById(id);
      if (!zone) {
        return res.status(404).json({ message: 'Zone not found' });
      }
      zone.name = name ?? zone.name;
      zone.status = status ?? zone.status;
      await zone.save();
    } else {
      zone = await Zone.create({
        name,
        status: status ?? 'active',
      });
    }
    res.status(id ? 200 : 201).json(zone);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteZone = async (req, res) => {
  try {
    const zone = await Zone.findById(req.params.id);
    if (!zone) {
      return res.status(404).json({ message: 'Zone not found' });
    }
    await zone.deleteOne();
    res.json({ message: 'Zone removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
