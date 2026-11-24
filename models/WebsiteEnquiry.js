import mongoose from 'mongoose';

// Every enquiry sent from the public website (booking form or contact form),
// kept even when it is added to an existing Lead, so nothing is lost.
const websiteEnquirySchema = mongoose.Schema(
  {
    type: { type: String, enum: ['booking', 'contact'], required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: '' },
    venue: { type: String, default: '' },
    message: { type: String, default: '' },
    eventDate: { type: String, default: null }, // YYYY-MM-DD as chosen by the bride
    slot: { type: String, default: '' },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    packageName: { type: String, default: '' },
    addonNames: { type: [String], default: [] },
    // Wedding location chosen on the website (prices depend on it).
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: 'District', default: null },
    district: { type: String, default: '' },
    region: { type: String, default: '' },
    // Package (for this location) + add-ons, worked out on the server from CRM prices.
    quotedTotal: { type: Number, default: null },
    utm: {
      source: { type: String, default: '' },
      medium: { type: String, default: '' },
      campaign: { type: String, default: '' },
    },
    page: { type: String, default: '' },
    ipHash: { type: String, default: '' }, // salted hash only — never the raw address
    // Lead link: 'created' = new Lead made from this; 'existing' = number already had a Lead.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },
    leadAction: { type: String, enum: ['created', 'existing', 'failed', ''], default: '' },
    status: { type: String, enum: ['new', 'contacted', 'closed', 'spam'], default: 'new', index: true },
    note: { type: String, default: '' },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

websiteEnquirySchema.index({ createdAt: -1 });

const WebsiteEnquiry = mongoose.model('WebsiteEnquiry', websiteEnquirySchema);

export default WebsiteEnquiry;
