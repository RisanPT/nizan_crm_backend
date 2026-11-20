import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { attachMarketingAccess } from '../controllers/marketingEodController.js';
import {
  listCountries, createCountry, updateCountry, deleteCountry, createCity, updateCity, deleteCity,
} from '../controllers/countryController.js';

// /api/countries — the marketing geography (Country → City). Everybody signed in reads it; the Marketing Manager / Admin change it.
const router = express.Router();
router.use(protect);
router.use(attachMarketingAccess);

router.route('/').get(listCountries).post(createCountry);
router.route('/cities/:cityId').put(updateCity).delete(deleteCity);
router.route('/:id').put(updateCountry).delete(deleteCountry);
router.post('/:id/cities', createCity);

export default router;
