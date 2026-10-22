import mongoose from 'mongoose';

// One concierge chat thread between a bridal client and the studio staff.
// MVP uses a single general thread per client (bookingId null); the optional
// bookingId lets per-booking threads be added later without a migration.
const conversationSchema = new mongoose.Schema(
  {
    clientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientUser', required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    clientName: { type: String, default: '' },
    clientPhone: { type: String, default: '' }, // denormalized for staff inbox search
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    lastMessageSenderType: { type: String, default: '' }, // client | staff | system
    unreadForStaff: { type: Number, default: 0 },
    unreadForClient: { type: Number, default: 0 },
  },
  { timestamps: true }
);

conversationSchema.index({ lastMessageAt: -1 });

const Conversation = mongoose.model('Conversation', conversationSchema);
export default Conversation;
