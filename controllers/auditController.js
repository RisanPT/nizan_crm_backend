import mongoose from 'mongoose';
import AuditLog, { AUDIT_ENTITIES } from '../models/AuditLog.js';

// @desc    HR / payroll change log
// @route   GET /api/audit?employeeId=&entity=&entityId=&limit=
// @access  Company-wide pay access only (canSeeAllEmployeePay)
export const getAuditLogs = async (req, res) => {
  try {
    const { employeeId, entity, entityId } = req.query;
    const filter = {};
    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(employeeId)) {
        return res.status(400).json({ message: 'Invalid employeeId' });
      }
      filter.employeeId = employeeId;
    }
    if (entityId) {
      if (!mongoose.Types.ObjectId.isValid(entityId)) {
        return res.status(400).json({ message: 'Invalid entityId' });
      }
      filter.entityId = entityId;
    }
    if (entity && entity !== 'all') {
      if (!AUDIT_ENTITIES.includes(entity)) {
        return res.status(400).json({ message: 'Invalid entity' });
      }
      filter.entity = entity;
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const logs = await AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
