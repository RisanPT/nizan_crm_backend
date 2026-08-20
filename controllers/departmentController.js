import Department, { DIVISIONS, SEED_DEPARTMENTS } from '../models/Department.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';

// Full-access roles can manage the org structure; department heads may read it.
const isAdmin = (u) => u?.role === 'admin' || u?.role === 'manager';
const canRead = (u) => isAdmin(u) || u?.isDepartmentHead;

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const populate = [{ path: 'head', select: 'name email role artistRole timeboxEmployeeId' }];

// Employees belonging to a department: linked by id, plus any whose free-text
// `department` matches this one's name but isn't linked yet. Shared by the list
// (memberCount) and the members endpoint so the two never disagree.
const memberFilter = (dept) => ({
  $or: [
    { departmentId: dept._id },
    { departmentId: null, department: new RegExp(`^\\s*${escapeRegExp(dept.name)}\\s*$`, 'i') },
  ],
});
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @route  GET /api/departments
export const getDepartments = async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Not permitted' });
  try {
    const depts = await Department.find({}).populate(populate).sort({ division: 1, name: 1 }).lean();
    // Member counts come from Employees (staff) in each department.
    const withCounts = await Promise.all(
      depts.map(async (d) => ({ ...d, memberCount: await Employee.countDocuments(memberFilter(d)) })),
    );
    res.json(withCounts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  GET /api/departments/:id/members — the staff (Employees) in a department
export const getDepartmentMembers = async (req, res) => {
  if (!canRead(req.user)) return res.status(403).json({ message: 'Not permitted' });
  try {
    const dept = await Department.findById(req.params.id).lean();
    if (!dept) return res.status(404).json({ message: 'Department not found' });
    const members = await Employee.find(memberFilter(dept))
      .select('name email role category department status timeboxEmployeeId')
      .sort({ name: 1 })
      .lean();
    res.json(members);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  POST /api/departments/assign-by-role
// Slot still-unassigned staff into their department by role — chiefly the
// Creative division: artists → Artist, drivers → Fleet. Idempotent.
export const assignStaffByRole = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const depts = await Department.find({}).lean();
    const byKey = new Map(depts.map((d) => [d.key, d._id]));
    // `artistRole` (artist|assistant|driver|staff) is the real classifier;
    // `role` is a free-text designation ("MUA", "Fleet Driver") used as a fallback.
    const ARTIST_RE = /artist|mua|makeup|hair|saree|drap|stylist/i;
    const DRIVER_RE = /driver/i;
    const rules = [
      { deptKey: 'artist', match: { departmentId: null, $or: [{ artistRole: { $in: ['artist', 'assistant'] } }, { category: 'creative' }, { role: ARTIST_RE }] } },
      { deptKey: 'fleet', match: { departmentId: null, $or: [{ artistRole: 'driver' }, { role: DRIVER_RE }] } },
    ];
    let assigned = 0;
    const perDept = {};
    for (const { deptKey, match } of rules) {
      const did = byKey.get(deptKey);
      if (!did) continue;
      const r = await Employee.updateMany(match, { $set: { departmentId: did } });
      const n = r.modifiedCount || 0;
      assigned += n;
      if (n) perDept[deptKey] = n;
    }
    res.json({
      assigned,
      perDept,
      message: assigned
        ? `Assigned ${assigned} staff to their departments (${Object.entries(perDept).map(([k, n]) => `${n} ${k}`).join(', ')}).`
        : 'All artists and drivers are already assigned.',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  POST /api/departments/seed  (idempotent — creates the 9 defaults)
export const seedDepartments = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    let created = 0;
    for (const d of SEED_DEPARTMENTS) {
      const exists = await Department.findOne({ key: d.key });
      if (!exists) {
        await Department.create({ ...d, isSystem: true });
        created += 1;
      }
    }
    res.json({ created, total: await Department.countDocuments({}) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  POST /api/departments
export const createDepartment = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'A department name is required' });
    const key = req.body.key ? slug(req.body.key) : slug(name);
    if (await Department.findOne({ key })) {
      return res.status(400).json({ message: `A department with key "${key}" already exists` });
    }
    const doc = await Department.create({
      key,
      name,
      division: DIVISIONS.includes(req.body.division) ? req.body.division : 'administrative',
      description: req.body.description || '',
      head: req.body.head || null,
      allowedRoleKeys: Array.isArray(req.body.allowedRoleKeys) ? req.body.allowedRoleKeys.map(String) : [],
      zoneIds: Array.isArray(req.body.zoneIds) ? req.body.zoneIds : [],
      stateIds: Array.isArray(req.body.stateIds) ? req.body.stateIds : [],
      regionIds: Array.isArray(req.body.regionIds) ? req.body.regionIds : [],
      active: req.body.active !== false,
      isSystem: false,
    });
    res.status(201).json(await Department.findById(doc._id).populate(populate).lean());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  PUT /api/departments/:id
export const updateDepartment = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const doc = await Department.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Department not found' });

    // Remember the current head so we can clear their flag if the head changes.
    const prevHeadId = doc.head ? String(doc.head) : null;

    const b = req.body;
    if (b.name !== undefined) doc.name = String(b.name).trim() || doc.name;
    if (b.division !== undefined && DIVISIONS.includes(b.division)) doc.division = b.division;
    if (b.description !== undefined) doc.description = b.description;
    if (b.head !== undefined) doc.head = b.head || null;
    if (b.allowedRoleKeys !== undefined) doc.allowedRoleKeys = Array.isArray(b.allowedRoleKeys) ? b.allowedRoleKeys.map(String) : [];
    if (b.zoneIds !== undefined) doc.zoneIds = Array.isArray(b.zoneIds) ? b.zoneIds : [];
    if (b.stateIds !== undefined) doc.stateIds = Array.isArray(b.stateIds) ? b.stateIds : [];
    if (b.regionIds !== undefined) doc.regionIds = Array.isArray(b.regionIds) ? b.regionIds : [];
    if (b.active !== undefined) doc.active = !!b.active;
    // `key` and `isSystem` are immutable once created.

    await doc.save();

    const newHeadId = doc.head ? String(doc.head) : null;
    // Head changed → clear the previous head's login flag, unless they still head
    // another department. Prevents a stale `isDepartmentHead: true` from lingering
    // on someone who was demoted / replaced as head.
    if (prevHeadId && prevHeadId !== newHeadId) {
      const stillHeadsElsewhere = await Department.exists({ _id: { $ne: doc._id }, head: prevHeadId });
      if (!stillHeadsElsewhere) {
        await User.updateOne({ employeeId: prevHeadId }, { $set: { isDepartmentHead: false } });
      }
    }

    // The head is an Employee; also ensure that Employee sits in this department,
    // and flag their login User (if any) as a department head for the delegation phase.
    if (doc.head) {
      await Employee.updateOne({ _id: doc.head }, { $set: { departmentId: doc._id } });
      await User.updateOne({ employeeId: doc.head }, { $set: { isDepartmentHead: true, departmentId: doc._id } });
    }
    res.json(await Department.findById(doc._id).populate(populate).lean());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  DELETE /api/departments/:id  (system depts can only be deactivated)
export const deleteDepartment = async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: 'Admin only' });
  try {
    const doc = await Department.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Department not found' });
    if (doc.isSystem) {
      return res.status(400).json({ message: 'A default department cannot be deleted — deactivate it instead.' });
    }
    const members = await User.countDocuments({ departmentId: doc._id });
    if (members > 0) {
      return res.status(400).json({ message: `Reassign the ${members} member(s) before deleting this department.` });
    }
    await doc.deleteOne();
    res.json({ message: 'Department deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
