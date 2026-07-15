import express from 'express';
import {
  getTrialPackages,
  getTrialPackageById,
  createTrialPackage,
  updateTrialPackage,
  deleteTrialPackage,
} from '../controllers/trialPackageController.js';

const router = express.Router();

router.route('/').get(getTrialPackages).post(createTrialPackage);
router
  .route('/:id')
  .get(getTrialPackageById)
  .put(updateTrialPackage)
  .delete(deleteTrialPackage);

export default router;
