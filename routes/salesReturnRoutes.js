import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  getSalesReturns,
  getSalesReturnStats,
  getSalesReturnById,
  createSalesReturn,
  updateSalesReturn,
  updateSalesReturnStatus,
  deleteSalesReturn,
} from '../controllers/salesReturnController.js';

const router = express.Router();

router.use(protect);

router.get('/', getSalesReturns);
router.get('/stats', getSalesReturnStats);
router.get('/:id', getSalesReturnById);
router.post('/', createSalesReturn);
router.put('/:id', updateSalesReturn);
router.patch('/:id/status', updateSalesReturnStatus);
router.delete('/:id', deleteSalesReturn);

export default router;
