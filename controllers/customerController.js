import Customer from '../models/Customer.js';

export const getCustomers = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Customer.find({})
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(currentLimit),
        Customer.countDocuments({}),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const customers = await Customer.find({}).sort({ createdAt: -1 });
    res.json(customers);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCustomer = async (req, res) => {
  const { name, email, phone, company, status } = req.body;

  try {
    // Match by email OR phone to avoid duplicates
    const query = [];
    if (email) query.push({ email });
    if (phone) query.push({ phone });

    const customerExists = query.length > 0
      ? await Customer.findOne({ $or: query })
      : null;

    if (customerExists) {
      return res.status(400).json({ message: 'Customer already exists' });
    }

    const customer = await Customer.create({
      name,
      email: email || `${phone}@placeholder.local`,
      phone,
      company,
      status,
    });

    res.status(201).json(customer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const { name, email, phone, company, status } = req.body;

    customer.name = name ?? customer.name;
    customer.email = email ?? customer.email;
    customer.phone = phone ?? customer.phone;
    customer.company = company ?? customer.company;
    customer.status = status ?? customer.status;

    const updated = await customer.save();
    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    await customer.deleteOne();
    res.json({ message: 'Customer removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
