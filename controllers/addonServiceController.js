import AddonService from '../models/AddonService.js';

export const getAddonServices = async (req, res) => {
  try {
    const addonServices = await AddonService.find({}).sort({ createdAt: -1 });
    res.json(addonServices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveAddonService = async (req, res) => {
  const { id, name, price, description, status } = req.body;

  try {
    let addonService;

    if (id) {
      addonService = await AddonService.findById(id);
      if (!addonService) {
        return res.status(404).json({ message: 'Add-on service not found' });
      }

      addonService.name = name ?? addonService.name;
      addonService.price = price ?? addonService.price;
      addonService.description = description ?? addonService.description;
      addonService.status = status ?? addonService.status;
      await addonService.save();
    } else {
      addonService = await AddonService.create({
        name,
        price,
        description,
        status: status ?? 'active',
      });
    }

    res.status(id ? 200 : 201).json(addonService);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteAddonService = async (req, res) => {
  try {
    const addonService = await AddonService.findById(req.params.id);
    if (!addonService) {
      return res.status(404).json({ message: 'Add-on service not found' });
    }

    await addonService.deleteOne();
    res.json({ message: 'Add-on service removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
