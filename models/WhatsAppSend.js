import mongoose from 'mongoose';

// One row per quotation / invoice the CRM sent to TeamN Chat (WhatsApp).
// TeamN Chat doesn't de-duplicate, so this is the CRM's own record of who sent
// what, to whom, and how it went.
const whatsAppSendSchema = mongoose.Schema(
  {
    mode: { type: String, enum: ['handover', 'send'], required: true },
    kind: { type: String, enum: ['quotation', 'invoice', 'confirmation'], required: true },
    reference: { type: String, default: '', trim: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    customerName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    filename: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    ok: { type: Boolean, default: false },
    httpStatus: { type: Number, default: 0 },
    error: { type: String, default: '' },
    // From TeamN Chat's reply.
    documentId: { type: String, default: '' },
    channel: { type: String, default: '' },
    sentAs: { type: String, default: '' }, // document | template (send mode)
    cost: { type: Number, default: 0 },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sentByName: { type: String, default: '' },
  },
  { timestamps: true }
);

whatsAppSendSchema.index({ bookingId: 1, createdAt: -1 });

const WhatsAppSend = mongoose.model('WhatsAppSend', whatsAppSendSchema);

export default WhatsAppSend;
