import Lead from '../models/Lead.js';

export const getLeads = async (req, res) => {
  try {
    const leads = await Lead.find({});
    res.json(leads);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createLead = async (req, res) => {
  const { name, email, phone, source, status } = req.body;

  try {
    const lead = await Lead.create({
      name,
      email,
      phone,
      source,
      status,
    });

    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
