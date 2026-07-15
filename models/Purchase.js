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

// One payment made against a vendor bill (Zoho "Payments Made").
const purchasePaymentSchema = mongoose.Schema(
  {
    amount: { type: Number, default: 0, min: 0 },
    date: { type: Date, default: Date.now },
    // cash / upi / bank_transfer / cheque / card / other
    mode: { type: String, default: 'cash', trim: true },
    note: { type: String, default: '', trim: true },
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
    // Accounts-payable due date for the bill (optional).
    dueDate: { type: Date, default: null },
    items: { type: [purchaseItemSchema], default: [] },
    // Taxable base = sum of line items (quantity * unitCost).
    total: { type: Number, default: 0 },
    // GST (input tax) on the vendor bill.
    gstEnabled: { type: Boolean, default: false },
    gstin: { type: String, default: '', trim: true },
    gstRate: { type: Number, default: 0 }, // percentage, e.g. 18
    gstAmount: { type: Number, default: 0 }, // tax value in currency
    interState: { type: Boolean, default: false }, // true => IGST, false => CGST+SGST
    // Whole bill fully settled. Kept for backward-compat; derived from amountPaid.
    paid: { type: Boolean, default: false },
    // Running total of payments made against grandTotal (= total + gstAmount).
    amountPaid: { type: Number, default: 0 },
    payments: { type: [purchasePaymentSchema], default: [] },
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
