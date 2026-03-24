import BlockedDate from '../models/BlockedDate.js';

const normalizeDay = (value) => {
  const raw = new Date(value);
  return new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
};

export const getBlockedDates = async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const query = activeOnly ? { active: true } : {};
    const blockedDates = await BlockedDate.find(query).sort({ date: 1 });
    res.json(blockedDates);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createBlockedDate = async (req, res) => {
  try {
    const { date, reason = '', active = true } = req.body;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    const normalizedDate = normalizeDay(date);
    const existing = await BlockedDate.findOne({ date: normalizedDate });

    if (existing) {
      existing.reason = reason;
      existing.active = active;
      await existing.save();
      return res.json(existing);
    }

    const blockedDate = await BlockedDate.create({
      date: normalizedDate,
      reason,
      active,
    });

    res.status(201).json(blockedDate);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateBlockedDate = async (req, res) => {
  try {
    const blockedDate = await BlockedDate.findById(req.params.id);

    if (!blockedDate) {
      return res.status(404).json({ message: 'Blocked date not found' });
    }

    const { date, reason, active } = req.body;

    if (date != null) {
      blockedDate.date = normalizeDay(date);
    }
    if (reason != null) {
      blockedDate.reason = reason;
    }
    if (active != null) {
      blockedDate.active = active;
    }

    await blockedDate.save();
    res.json(blockedDate);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteBlockedDate = async (req, res) => {
  try {
    const blockedDate = await BlockedDate.findById(req.params.id);

    if (!blockedDate) {
      return res.status(404).json({ message: 'Blocked date not found' });
    }

    await blockedDate.deleteOne();
    res.json({ message: 'Blocked date removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
