import express from 'express';
import {
  deletePackage,
  getPackageById,
  getPackages,
  reorderPackages,
  savePackage,
} from '../controllers/packageController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.get('/', getPackages);
router.get('/:id', getPackageById);

router.use(protect);
router.post('/', savePackage);
// Before '/:id' so "order" isn't read as a package id.
router.put('/order', reorderPackages);
router.put('/:id', savePackage);
router.delete('/:id', deletePackage);

export default router;
