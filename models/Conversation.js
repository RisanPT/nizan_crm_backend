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
    // The staff member who owns the chat: the first to reply (as before), or whoever the CRM Head assigns it to.
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedStaffName: { type: String, default: '' },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // '' = from before this was recorded | first_reply = whoever answered first | head = assigned by the CRM Head | auto
    assignedVia: { type: String, enum: ['', 'first_reply', 'head', 'claim', 'auto'], default: '' },
    // Since when the client has been waiting for an answer (their first message after the last staff reply); null = nobody waiting.
    awaitingSince: { type: Date, default: null },
    // When the owner and the CRM Head were told the client has waited too long (once per wait — utils/crmSweep.js).
    awaitingNotifiedAt: { type: Date, default: null },
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
// each owner's chats, and the chats waiting for an answer
conversationSchema.index({ assignedStaffId: 1, lastMessageAt: -1 });
conversationSchema.index({ awaitingSince: 1 });

const Conversation = mongoose.model('Conversation', conversationSchema);
export default Conversation;
