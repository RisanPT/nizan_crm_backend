import express from 'express';
import {
  getTemplates,
  seedLetterTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getGenerated,
  generateLetter,
  deleteGenerated,
} from '../controllers/letterController.js';
import { protect, attachRolePermissions } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect, attachRolePermissions);

router.post('/templates/seed', seedLetterTemplates);
router.route('/templates').get(getTemplates).post(createTemplate);
router.route('/templates/:id').put(updateTemplate).delete(deleteTemplate);


router.get('/generated', getGenerated);
router.post('/generate', generateLetter);
router.delete('/generated/:id', deleteGenerated);

export default router;
