import express from 'express';
import {
  getProducts,
  getProductByBarcode,
  createProduct,
  bulkCreateProducts,
  updateProduct,
  deleteProduct,
  getKits,
  createKit,
  updateKit,
  deleteKit,
  updateKitItem,
  getPurchases,
  createPurchase,
  consumeForWork,
  setProductFill,
  lookupExternalBarcode,
  setPurchasePaid,
  recordPurchasePayment,
  updatePurchase,
  deletePurchase,
  getVendors,
  createVendor,
  updateVendor,
  deleteVendor,
} from '../controllers/inventoryController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/products').get(getProducts).post(createProduct);
router.post('/products/bulk', bulkCreateProducts);
router.get('/products/barcode/:code', getProductByBarcode);
router.get('/products/external/:code', lookupExternalBarcode);
router.route('/products/:id').put(updateProduct).delete(deleteProduct);
router.patch('/products/:id/fill', setProductFill);
router.post('/consume', consumeForWork);

router.route('/kits').get(getKits).post(createKit);
router.route('/kits/:id').put(updateKit).delete(deleteKit);
router.patch('/kits/:id/item/:index', updateKitItem);

router.route('/purchases').get(getPurchases).post(createPurchase);
router.patch('/purchases/:id/paid', setPurchasePaid);
router.post('/purchases/:id/payments', recordPurchasePayment);
router.route('/purchases/:id').put(updatePurchase).delete(deletePurchase);

router.route('/vendors').get(getVendors).post(createVendor);
router.route('/vendors/:id').put(updateVendor).delete(deleteVendor);

export default router;
