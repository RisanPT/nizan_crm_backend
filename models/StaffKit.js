import mongoose from 'mongoose';

const kitItemSchema = mongoose.Schema(
  {
    // Link to the studio product this kit item draws from (null = custom item
    // not tracked in studio stock). Used to deplete the tube on work complete.
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryProduct',
      default: null,
    },
    name: { type: String, required: true, trim: true },
    brand: { type: String, default: '', trim: true },
    shade: { type: String, default: '', trim: true },
    // Per-artist allocation: tubes assigned to this artist and the open tube's
    // remaining fill. Independent of studio stock and of other artists.
    quantity: { type: Number, default: 1, min: 0 },
    fillLevel: { type: Number, default: 100, min: 0, max: 100 },
  },
  { _id: false }
);

const staffKitSchema = mongoose.Schema(
  {
    // Artist / kit name shown on the card.
    name: {
      type: String,
      required: [true, 'Please add a kit name'],
      trim: true,
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    items: { type: [kitItemSchema], default: [] },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const StaffKit = mongoose.model('StaffKit', staffKitSchema);

export default StaffKit;
