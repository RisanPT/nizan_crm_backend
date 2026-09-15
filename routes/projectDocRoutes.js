import express from 'express';
import {
  getProjectDocs,
  createProjectDoc,
  updateProjectDoc,
  deleteProjectDoc,
  uploadVersion,
  downloadVersion,
  deleteVersion,
} from '../controllers/projectDocController.js';
import { protect } from '../middleware/authMiddleware.js';
import { uploadDoc } from '../config/cloudinary.js';

const router = express.Router();

router.use(protect);

router.route('/').get(getProjectDocs).post(createProjectDoc);
router.post(
  '/:id/versions',
  uploadDoc.fields([
    { name: 'pdf', maxCount: 1 },
    { name: 'doc', maxCount: 1 },
  ]),
  uploadVersion,
);
router.get('/:id/versions/:version/download', downloadVersion);
router.delete('/:id/versions/:version', deleteVersion);
router.route('/:id').put(updateProjectDoc).delete(deleteProjectDoc);

export default router;
