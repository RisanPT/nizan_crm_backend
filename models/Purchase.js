import mongoose from 'mongoose';

const purchaseItemSchema = mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryProduct',
      default: null,
    },
    name: { type: String, default: '', trim: true },
    brand: { type: String, default: '', trim: true },
    shade: { type: String, default: '', trim: true },
    barcode: { type: String, default: '', trim: true },
    category: { type: String, default: 'Other', trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    unitCost: { type: Number, default: 0, min: 0 },
    // true  => stock-in: creates/updates an inventory product (tube tracked).
    // false => expense-only line (e.g. software/service): ledgered, not stocked.
    stockIn: { type: Boolean, default: true },
  },
  { _id: false }
);

const purchaseSchema = mongoose.Schema(
  {
    supplier: { type: String, default: '', trim: true },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    invoiceNo: { type: String, default: '', trim: true },
    // Cloudinary URL of the uploaded supplier bill / tax invoice.
    billImage: { type: String, default: '' },
    date: { type: Date, default: Date.now },
    items: { type: [purchaseItemSchema], default: [] },
    total: { type: Number, default: 0 },
    // Ledger payment status for the whole purchase.
    paid: { type: Boolean, default: false },
    // null => studio purchase; set => an artist's own purchase.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const Purchase = mongoose.model('Purchase', purchaseSchema);

export default Purchase;
