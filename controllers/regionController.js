import Region from '../models/Region.js';

export const getRegions = async (req, res) => {
  try {
    const query = req.query.active === 'true' ? { status: 'active' } : {};
    const regions = await Region.find(query).sort({ name: 1 });
    res.json(regions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getRegionById = async (req, res) => {
  try {
    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ message: 'Region not found' });
    }
    res.json(region);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveRegion = async (req, res) => {
  const { id, name, status } = req.body;

  try {
    let region;
    if (id) {
      region = await Region.findById(id);
      if (!region) {
        return res.status(404).json({ message: 'Region not found' });
      }
      region.name = name ?? region.name;
      region.status = status ?? region.status;
      await region.save();
    } else {
      region = await Region.create({
        name,
        status: status ?? 'active',
      });
    }
    res.status(id ? 200 : 201).json(region);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteRegion = async (req, res) => {
  try {
    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ message: 'Region not found' });
    }
    await region.deleteOne();
    res.json({ message: 'Region removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
