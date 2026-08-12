import mongoose from 'mongoose';

// Singleton GST configuration for the studio. Drives how booking sales are
// split into taxable value + output tax when posted to the ledger.
const gstSettingSchema = mongoose.Schema(
  {
    // Master switch — off means sales post revenue gross (no output GST).
    enabled: { type: Boolean, default: true },
    // GST rate on services, e.g. 5 or 18.
    rate: { type: Number, default: 5, min: 0, max: 100 },
    // true  → the booking price already contains GST (back it out);
    // false → GST is charged on top of the booking price.
    pricesIncludeTax: { type: Boolean, default: true },
    // true  → inter-state supply → IGST; false → intra-state → CGST + SGST.
    interState: { type: Boolean, default: false },
    // Studio's home state code (optional, for GST returns).
    homeStateCode: { type: String, default: '', trim: true },
    gstin: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

const GstSetting = mongoose.model('GstSetting', gstSettingSchema);

export default GstSetting;
