import mongoose from 'mongoose';

const kitItemSchema = mongoose.Schema(
  {
    // Link to the studio product this kit item was issued from (null = custom
    // item not tracked in studio stock).
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InventoryProduct',
      default: null,
    },
    name: { type: String, required: true, trim: true },
    brand: { type: String, default: '', trim: true },
    shade: { type: String, default: '', trim: true },
    // Units currently held in this kit. Issuing units moves them out of studio
    // stock (see KitMovement); they never come back unless returned.
    quantity: { type: Number, default: 1, min: 0 },
    // When this product was first handed to the kit's artist. Usage is the
    // number of works the artist completed as lead on or after this date.
    assignedAt: { type: Date, default: null },
    // Units issued to this kit since assignedAt, net of returns. Works done ÷
    // issuedTotal gives an approximate "works per unit".
    issuedTotal: { type: Number, default: 0, min: 0 },
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
