import Subscription from '../models/Subscription.js';

const subscriptionPopulate = [
  { path: 'ownerEmployeeId', select: 'name phone department artistRole status' },
  { path: 'createdBy', select: 'name role' },
];

export const getSubscriptions = async (req, res) => {
  try {
    const { department, status, billingCycle, search } = req.query;
    const filter = {};

    if (department && department !== 'All') {
      filter.department = department;
    }

    if (status && status !== 'All' && status !== 'all') {
      filter.status = status;
    }

    if (billingCycle && billingCycle !== 'All') {
      filter.billingCycle = billingCycle;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [
        { name: searchRegex },
        { plan: searchRegex },
        { ownerName: searchRegex },
        { notes: searchRegex },
      ];
    }

    const subscriptions = await Subscription.find(filter)
      .populate(subscriptionPopulate)
      .sort({ renewalDate: 1, createdAt: -1 });

    res.json(subscriptions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSubscriptionStats = async (req, res) => {
  try {
    const all = await Subscription.find({});
    const now = new Date();
    const next30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let activeCount = 0;
    let monthlyRunRate = 0;
    let annualizedCost = 0;
    let upcomingRenewalsCount = 0;
    const departmentBreakdown = {};
    const renewalsNext30Days = [];

    for (const sub of all) {
      const cost = Number(sub.cost) || 0;
      let monthlyEquivalent = 0;

      if (sub.billingCycle === 'monthly') {
        monthlyEquivalent = cost;
      } else if (sub.billingCycle === 'quarterly') {
        monthlyEquivalent = cost / 3;
      } else if (sub.billingCycle === 'yearly') {
        monthlyEquivalent = cost / 12;
      } else {
        monthlyEquivalent = cost / 12; // one-time amortized
      }

      if (sub.status === 'active') {
        activeCount += 1;
        monthlyRunRate += monthlyEquivalent;
        annualizedCost += monthlyEquivalent * 12;

        const dept = sub.department || 'IT';
        departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + monthlyEquivalent;
      }

      if (sub.status === 'active' && sub.renewalDate) {
        const renewal = new Date(sub.renewalDate);
        if (renewal >= now && renewal <= next30Days) {
          upcomingRenewalsCount += 1;
          renewalsNext30Days.push(sub);
        }
      }
    }

    res.json({
      totalCount: all.length,
      activeCount,
      monthlyRunRate: Math.round(monthlyRunRate),
      annualizedCost: Math.round(annualizedCost),
      upcomingRenewalsCount,
      departmentBreakdown,
      renewalsNext30Days,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSubscriptionById = async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id).populate(subscriptionPopulate);
    if (!sub) {
      return res.status(404).json({ message: 'Subscription not found' });
    }
    res.json(sub);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createSubscription = async (req, res) => {
  try {
    const {
      name,
      department,
      plan,
      cost,
      billingCycle,
      currency,
      renewalDate,
      paymentMethod,
      ownerEmployeeId,
      ownerName,
      status,
      autoRenew,
      websiteUrl,
      notes,
      receiptImage,
    } = req.body;

    const sub = new Subscription({
      name,
      department: department || 'IT',
      plan: plan || '',
      cost: Number(cost) || 0,
      billingCycle: billingCycle || 'monthly',
      currency: currency || 'INR',
      renewalDate: renewalDate ? new Date(renewalDate) : new Date(),
      paymentMethod: paymentMethod || 'credit_card',
      ownerEmployeeId: ownerEmployeeId || null,
      ownerName: ownerName || '',
      status: status || 'active',
      autoRenew: autoRenew !== undefined ? Boolean(autoRenew) : true,
      websiteUrl: websiteUrl || '',
      notes: notes || '',
      receiptImage: receiptImage || '',
      createdBy: req.user?._id || null,
    });

    await sub.save();

    const populated = await Subscription.findById(sub._id).populate(subscriptionPopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateSubscription = async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    const {
      name,
      department,
      plan,
      cost,
      billingCycle,
      currency,
      renewalDate,
      paymentMethod,
      ownerEmployeeId,
      ownerName,
      status,
      autoRenew,
      websiteUrl,
      notes,
      receiptImage,
    } = req.body;

    if (name !== undefined) sub.name = name;
    if (department !== undefined) sub.department = department;
    if (plan !== undefined) sub.plan = plan;
    if (cost !== undefined) sub.cost = Number(cost) || 0;
    if (billingCycle !== undefined) sub.billingCycle = billingCycle;
    if (currency !== undefined) sub.currency = currency;
    if (renewalDate !== undefined) sub.renewalDate = new Date(renewalDate);
    if (paymentMethod !== undefined) sub.paymentMethod = paymentMethod;
    if (ownerEmployeeId !== undefined) sub.ownerEmployeeId = ownerEmployeeId || null;
    if (ownerName !== undefined) sub.ownerName = ownerName;
    if (status !== undefined) sub.status = status;
    if (autoRenew !== undefined) sub.autoRenew = Boolean(autoRenew);
    if (websiteUrl !== undefined) sub.websiteUrl = websiteUrl;
    if (notes !== undefined) sub.notes = notes;
    if (receiptImage !== undefined) sub.receiptImage = receiptImage;

    await sub.save();

    const populated = await Subscription.findById(sub._id).populate(subscriptionPopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteSubscription = async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    await sub.deleteOne();
    res.json({ message: 'Subscription deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
