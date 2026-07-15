import TrialPackage from '../models/TrialPackage.js';

// @desc    Get all trial packages
// @route   GET /api/trial-packages
// @access  Private
export const getTrialPackages = async (req, res) => {
  try {
    const packages = await TrialPackage.find({}).sort({ name: 1 });
    res.json(packages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single trial package
// @route   GET /api/trial-packages/:id
// @access  Private
export const getTrialPackageById = async (req, res) => {
  try {
    const pkg = await TrialPackage.findById(req.params.id);
    if (pkg) {
      res.json(pkg);
    } else {
      res.status(404).json({ message: 'Trial Package not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a trial package
// @route   POST /api/trial-packages
// @access  Private
export const createTrialPackage = async (req, res) => {
  try {
    const { name, price, description } = req.body;
    const pkgExists = await TrialPackage.findOne({ name });
    if (pkgExists) {
      return res.status(400).json({ message: 'Trial Package already exists' });
    }
    const pkg = await TrialPackage.create({ name, price, description });
    res.status(201).json(pkg);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a trial package
// @route   PUT /api/trial-packages/:id
// @access  Private
export const updateTrialPackage = async (req, res) => {
  try {
    const { name, price, description } = req.body;
    const pkg = await TrialPackage.findById(req.params.id);
    
    if (pkg) {
      pkg.name = name || pkg.name;
      pkg.price = price !== undefined ? price : pkg.price;
      pkg.description = description !== undefined ? description : pkg.description;
      
      const updatedPkg = await pkg.save();
      res.json(updatedPkg);
    } else {
      res.status(404).json({ message: 'Trial Package not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete a trial package
// @route   DELETE /api/trial-packages/:id
// @access  Private
export const deleteTrialPackage = async (req, res) => {
  try {
    const pkg = await TrialPackage.findByIdAndDelete(req.params.id);
    if (pkg) {
      res.json({ message: 'Trial Package removed' });
    } else {
      res.status(404).json({ message: 'Trial Package not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
