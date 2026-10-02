import mongoose from 'mongoose';

// A custom inventory category added from the Stock List. Built-in categories
// (Prep, Eye, Base, …) and categories already used by products are NOT stored
// here — they are merged in by the API and are read-only, so adding this
// collection never touches existing products.
const inventoryCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    // Lower-cased name for case-insensitive uniqueness ("Nails" == "nails").
    key: { type: String, required: true, unique: true, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

const InventoryCategory = mongoose.model(
  'InventoryCategory',
  inventoryCategorySchema
);

export default InventoryCategory;
