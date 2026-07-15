import Trial from '../models/Trial.js';

// ── Helpers ─────────────────────────────────────────────────────────────────
const normalizeTrialItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    packageName: String(item.packageName ?? '').trim(),
    lookLabel: String(item.lookLabel ?? '').trim(),
    notes: String(item.notes ?? '').trim(),
    outcome: ['pending', 'approved', 'needs_revision', 'rejected'].includes(item.outcome)
      ? item.outcome
      : 'pending',
    price: Number(item.price) || 0,
  }));
};

// ── GET /api/trials ─────────────────────────────────────────────────────────
// Query params: ?month=YYYY-MM  (optional — filters by trialDate prefix)
export const getTrials = async (req, res) => {
  try {
    const filter = {};
    if (req.query.month) {
      // e.g. month=2026-07 → match all trialDate starting with "2026-07"
      filter.trialDate = { $regex: `^${req.query.month}` };
    }
    const trials = await Trial.find(filter).sort({ trialDate: -1, createdAt: -1 });
    res.json(trials);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/trials/:id ──────────────────────────────────────────────────────
export const getTrialById = async (req, res) => {
  try {
    const trial = await Trial.findById(req.params.id);
    if (!trial) return res.status(404).json({ message: 'Trial not found' });
    res.json(trial);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/trials ─────────────────────────────────────────────────────────
export const createTrial = async (req, res) => {
  try {
    const {
      clientName,
      phone,
      email = '',
      trialDate,
      startTime = '',
      endTime = '',
      status = 'scheduled',
      notes = '',
      trialItems = [],
      bookingId = null,
    } = req.body;

    if (!clientName?.trim()) {
      return res.status(400).json({ message: 'Client name is required' });
    }
    if (!phone?.trim()) {
      return res.status(400).json({ message: 'Phone number is required' });
    }
    if (!trialDate?.trim()) {
      return res.status(400).json({ message: 'Trial date is required' });
    }

    const trial = new Trial({
      clientName: clientName.trim(),
      phone: phone.trim(),
      email: email.trim(),
      trialDate: trialDate.trim(),
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      status,
      notes: notes.trim(),
      trialItems: normalizeTrialItems(trialItems),
      bookingId: bookingId || null,
    });

    const saved = await trial.save();
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /api/trials/:id ──────────────────────────────────────────────────────
export const updateTrial = async (req, res) => {
  try {
    const trial = await Trial.findById(req.params.id);
    if (!trial) return res.status(404).json({ message: 'Trial not found' });

    const {
      clientName,
      phone,
      email,
      trialDate,
      startTime,
      endTime,
      status,
      notes,
      trialItems,
      bookingId,
    } = req.body;

    if (clientName !== undefined) trial.clientName = String(clientName).trim();
    if (phone !== undefined) trial.phone = String(phone).trim();
    if (email !== undefined) trial.email = String(email).trim();
    if (trialDate !== undefined) trial.trialDate = String(trialDate).trim();
    if (startTime !== undefined) trial.startTime = String(startTime).trim();
    if (endTime !== undefined) trial.endTime = String(endTime).trim();
    if (status !== undefined && ['scheduled', 'completed', 'postponed', 'cancelled'].includes(status)) {
      trial.status = status;
    }
    if (notes !== undefined) trial.notes = String(notes).trim();
    if (Array.isArray(trialItems)) {
      trial.trialItems = normalizeTrialItems(trialItems);
    }
    if (bookingId !== undefined) trial.bookingId = bookingId || null;

    const updated = await trial.save();
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/trials/:id ───────────────────────────────────────────────────
export const deleteTrial = async (req, res) => {
  try {
    const trial = await Trial.findByIdAndDelete(req.params.id);
    if (!trial) return res.status(404).json({ message: 'Trial not found' });
    res.json({ message: 'Trial deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
