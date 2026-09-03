import ExpenseCategory, {
  DEFAULT_EXPENSE_CATEGORIES,
} from '../models/ExpenseCategory.js';
import { isApprover, resolveUserDeptName } from '../utils/departmentScope.js';

// Which department the caller is acting on. Approvers (Accounts/Admin) may pass
// any `department`; everyone else is pinned to their own. Returns '' when a
// non-approver has no department set (caller should 400).
const departmentForRequest = async (req, explicit) => {
  if (isApprover(req.user)) {
    return (explicit || '').trim();
  }
  return resolveUserDeptName(req.user);
};

// GET /expense-categories?department=IT
// Lazily seeds the default categories the first time a department is opened, so
// every department starts with the familiar list and the head takes it from
// there. Returns that department's ACTIVE categories.
export const getExpenseCategories = async (req, res) => {
  try {
    const department = await departmentForRequest(req, req.query.department);
    if (!department) {
      return res.status(400).json({
        message: isApprover(req.user)
          ? 'A department is required.'
          : 'Your account is not linked to a department. Ask an admin to set it.',
      });
    }

    // Bootstrap only when the department has NEVER had a category (active or
    // not) — so a department that intentionally emptied its list is not
    // re-seeded.
    const total = await ExpenseCategory.countDocuments({ department });
    if (total === 0) {
      await ExpenseCategory.insertMany(
        DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
          name,
          department,
          createdBy: req.user?._id ?? null,
        })),
        { ordered: false }
      ).catch(() => {}); // ignore races/dupes
    }

    const categories = await ExpenseCategory.find({ department, active: true })
      .sort({ name: 1 })
      .lean();
    res.json(categories);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// POST /expense-categories  { name, department? }
export const createExpenseCategory = async (req, res) => {
  try {
    const name = String(req.body.name ?? '').trim();
    if (!name) {
      return res.status(400).json({ message: 'Category name is required.' });
    }

    const department = await departmentForRequest(req, req.body.department);
    if (!department) {
      return res.status(400).json({
        message: isApprover(req.user)
          ? 'A department is required.'
          : 'Your account is not linked to a department. Ask an admin to set it.',
      });
    }

    // Case-insensitive duplicate guard within the department. If a soft-deleted
    // category with the same name exists, revive it instead of erroring.
    const existing = await ExpenseCategory.findOne({
      department,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    });
    if (existing) {
      if (!existing.active) {
        existing.active = true;
        await existing.save();
        return res.status(200).json(existing);
      }
      return res
        .status(409)
        .json({ message: 'That category already exists for this department.' });
    }

    const category = await ExpenseCategory.create({
      name,
      department,
      createdBy: req.user?._id ?? null,
    });
    res.status(201).json(category);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PUT /expense-categories/:id  { name?, active? }
export const updateExpenseCategory = async (req, res) => {
  try {
    const category = await ExpenseCategory.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    // A department head may only touch their own department's categories.
    if (!isApprover(req.user)) {
      const deptName = await resolveUserDeptName(req.user);
      if (!deptName || deptName !== category.department) {
        return res
          .status(403)
          .json({ message: 'Not authorized to edit this category.' });
      }
    }

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ message: 'Category name is required.' });
      }
      // Guard against renaming onto another existing category.
      const clash = await ExpenseCategory.findOne({
        _id: { $ne: category._id },
        department: category.department,
        name: {
          $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          $options: 'i',
        },
      });
      if (clash) {
        return res
          .status(409)
          .json({ message: 'Another category with that name already exists.' });
      }
      category.name = name;
    }
    if (req.body.active !== undefined) {
      category.active = req.body.active === true || req.body.active === 'true';
    }

    await category.save();
    res.json(category);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE /expense-categories/:id  — soft delete (active:false).
export const deleteExpenseCategory = async (req, res) => {
  try {
    const category = await ExpenseCategory.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    if (!isApprover(req.user)) {
      const deptName = await resolveUserDeptName(req.user);
      if (!deptName || deptName !== category.department) {
        return res
          .status(403)
          .json({ message: 'Not authorized to delete this category.' });
      }
    }

    category.active = false;
    await category.save();
    res.json({ message: 'Category removed.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
