import Budget from '../models/Budget.js';

// @desc    Get budgets
// @route   GET /api/budgets
// @access  Private
export const getBudgets = async (req, res) => {
  try {
    const { month, year, category } = req.query;
    const filter = {};
    if (month) filter.month = Number(month);
    if (year) filter.year = Number(year);
    if (category) filter.category = category;

    const budgets = await Budget.find(filter);
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Set or update budget
// @route   POST /api/budgets
// @access  Private
export const setBudget = async (req, res) => {
  try {
    const { month, year, category, amount } = req.body;

    const existingBudget = await Budget.findOne({
      month: Number(month),
      year: Number(year),
      category: category || 'General',
    });

    if (existingBudget) {
      existingBudget.amount = Number(amount);
      const updatedBudget = await existingBudget.save();
      return res.json(updatedBudget);
    }

    const budget = new Budget({
      month: Number(month),
      year: Number(year),
      category: category || 'General',
      amount: Number(amount),
    });

    const createdBudget = await budget.save();
    res.status(201).json(createdBudget);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
