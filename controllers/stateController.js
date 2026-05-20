import State from '../models/State.js';

export const getStates = async (req, res) => {
  try {
    const query = req.query.active === 'true' ? { status: 'active' } : {};
    if (req.query.zoneId) {
      query.zone = req.query.zoneId;
    }

    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        State.find(query).populate('zone', 'name status').sort({ name: 1 }).skip(skip).limit(currentLimit),
        State.countDocuments(query),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const states = await State.find(query).populate('zone', 'name status').sort({ name: 1 });
    res.json(states);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getStateById = async (req, res) => {
  try {
    const state = await State.findById(req.params.id).populate('zone', 'name status');
    if (!state) {
      return res.status(404).json({ message: 'State not found' });
    }
    res.json(state);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const saveState = async (req, res) => {
  const { id, name, zoneId, status } = req.body;

  try {
    let state;
    if (id) {
      state = await State.findById(id);
      if (!state) {
        return res.status(404).json({ message: 'State not found' });
      }
      state.name = name ?? state.name;
      state.zone = zoneId ?? state.zone;
      state.status = status ?? state.status;
      await state.save();
    } else {
      state = await State.create({
        name,
        zone: zoneId,
        status: status ?? 'active',
      });
    }
    const populatedState = await State.findById(state._id).populate('zone', 'name status');
    res.status(id ? 200 : 201).json(populatedState);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteState = async (req, res) => {
  try {
    const state = await State.findById(req.params.id);
    if (!state) {
      return res.status(404).json({ message: 'State not found' });
    }
    await state.deleteOne();
    res.json({ message: 'State removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
