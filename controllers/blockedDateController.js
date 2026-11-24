import BlockedDate from '../models/BlockedDate.js';
import { dayKey, dayWindow } from '../utils/slots.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Store a blocked day as UTC midnight of the calendar day picked, whatever the
// server's timezone. A 'YYYY-MM-DD…' value is taken at its face date (the app
// sends the picked day); anything else by its India (IST) day.
const normalizeDay = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dayKey(value);
};

// Older rows were saved at the server's local midnight; match either form.
const sameDay = (day) => ({ date: dayWindow(day, new Date(day.getTime() + ONE_DAY_MS)) });

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
    if (Number.isNaN(normalizedDate.getTime())) {
      return res.status(400).json({ message: 'A valid date is required' });
    }
    const existing = await BlockedDate.findOne(sameDay(normalizedDate));

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
