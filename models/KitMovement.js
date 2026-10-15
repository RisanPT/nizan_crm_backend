import mongoose from 'mongoose';

// Append-only log of studio stock handed to (or taken back from) staff kits.
// Every assignment, return and write-off is one row, so the inventory manager
// can always answer "who got what, when, and from whom".
//   assign  → units moved studio stock → kit   (studio quantity decreases)
//   return  → units moved kit → studio stock   (studio quantity increases)
//   used_up → units removed from the kit as consumed (studio unchanged)
export const KIT_MOVEMENT_TYPES = ['assign', 'return', 'used_up'];

const kitMovementSchema = mongoose.Schema(
  {
    kit: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffKit', default: null, index: true },
    kitName: { type: String, default: '', trim: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryProduct', default: null, index: true },
    productName: { type: String, default: '', trim: true },
    brand: { type: String, default: '', trim: true },
    shade: { type: String, default: '', trim: true },
    type: { type: String, enum: KIT_MOVEMENT_TYPES, required: true },
    // Always positive; `type` gives the direction.
    quantity: { type: Number, required: true, min: 1 },
    // Studio stock right after this movement (null when the studio product no
    // longer exists, e.g. returning units of a deleted product).
    studioQtyAfter: { type: Number, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const KitMovement = mongoose.model('KitMovement', kitMovementSchema);

export default KitMovement;
