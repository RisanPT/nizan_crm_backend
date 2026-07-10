import mongoose from "mongoose";

// A supplier the studio buys inventory from (e.g. from a GST tax invoice).
const vendorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    gstNumber: { type: String, default: "", trim: true },
    phone: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    stateCode: { type: String, default: "", trim: true },
    bankName: { type: String, default: "", trim: true },
    bankAccount: { type: String, default: "", trim: true },
    bankIfsc: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    // null => studio-level vendor list (managed by inventory managers).
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
  },
  { timestamps: true }
);

const Vendor = mongoose.model("Vendor", vendorSchema);

export default Vendor;
