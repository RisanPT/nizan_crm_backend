import Pincode from '../models/Pincode.js';

export const getPincodes = async (req, res) => {
  try {
    const query = req.query.active === 'true' ? { status: 'active' } : {};
    if (req.query.districtId) {
      query.district = req.query.districtId;
    }

    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        Pincode.find(query)
          .populate({
            path: 'district',
            populate: {
              path: 'region',
              populate: {
                path: 'state',
                populate: {
                  path: 'zone'
                }
              }
            }
          })
          .sort({ code: 1 })
          .skip(skip)
          .limit(currentLimit),
        Pincode.countDocuments(query),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const pincodes = await Pincode.find(query)
      .populate({
        path: 'district',
        populate: {
          path: 'region',
          populate: {
            path: 'state',
            populate: {
              path: 'zone'
            }
          }
        }
      })
      .sort({ code: 1 });
    res.json(pincodes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getPincodeById = async (req, res) => {
  try {
    const pincode = await Pincode.findById(req.params.id)
      .populate({
        path: 'district',
        populate: {
          path: 'region',
          populate: {
            path: 'state',
            populate: {
              path: 'zone'
            }
          }
        }
      });
    if (!pincode) {
      return res.status(404).json({ message: 'Pincode not found' });
    }
    res.json(pincode);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const savePincode = async (req, res) => {
  const { id, code, districtId, status } = req.body;

  try {
    let pincode;
    if (id) {
      pincode = await Pincode.findById(id);
      if (!pincode) {
        return res.status(404).json({ message: 'Pincode not found' });
      }
      pincode.code = code ?? pincode.code;
      pincode.district = districtId ?? pincode.district;
      pincode.status = status ?? pincode.status;
      await pincode.save();
    } else {
      pincode = await Pincode.create({
        code,
        district: districtId,
        status: status ?? 'active',
      });
    }
    const populatedPincode = await Pincode.findById(pincode._id)
      .populate({
        path: 'district',
        populate: {
          path: 'region',
          populate: {
            path: 'state',
            populate: {
              path: 'zone'
            }
          }
        }
      });
    res.status(id ? 200 : 201).json(populatedPincode);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deletePincode = async (req, res) => {
  try {
    const pincode = await Pincode.findById(req.params.id);
    if (!pincode) {
      return res.status(404).json({ message: 'Pincode not found' });
    }
    await pincode.deleteOne();
    res.json({ message: 'Pincode removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
