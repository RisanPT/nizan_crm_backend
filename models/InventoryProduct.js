import mongoose from 'mongoose';

const inventoryProductSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a product name'],
      trim: true,
    },
    brand: { type: String, default: '', trim: true },
    shade: { type: String, default: '', trim: true },
    // Scannable code (EAN/UPC or custom). Indexed for fast barcode lookup.
    barcode: { type: String, default: '', trim: true, index: true },
    // Whole tubes/units on hand (sealed spares + the one currently open).
    quantity: { type: Number, default: 0, min: 0 },
    // Tube model: the currently-open tube's remaining fill, 0..100 (100 = full).
    // Depletes as artists complete works; hitting 0 opens the next tube.
    fillLevel: { type: Number, default: 100, min: 0, max: 100 },
    // Fixed % of a tube consumed each time a work using this product completes.
    usagePerWork: { type: Number, default: 10, min: 0, max: 100 },
    price: { type: Number, default: 0, min: 0 },
    category: { type: String, default: 'Other', trim: true },
    // Display group, e.g. 'Foundation', 'Setting & Fixing'.
    productType: { type: String, default: '', trim: true },
    expiry: { type: Date, default: null },
    lowStockThreshold: { type: Number, default: 2 },
    // null => studio inventory (managed by inventory_manager / admin / manager).
    // set  => an artist's personal inventory (their Employee id).
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const InventoryProduct = mongoose.model('InventoryProduct', inventoryProductSchema);

export default InventoryProduct;
