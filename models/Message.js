import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    senderType: { type: String, enum: ['client', 'staff', 'system'], required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, default: null }, // ClientUser or User
    senderName: { type: String, default: '' },
    text: { type: String, default: '' },
    // image | audio. `durationMs` is set for voice notes only.
    attachments: {
      type: [
        {
          _id: false,
          url: String,
          type: { type: String, enum: ['image', 'audio'], default: 'image' },
          durationMs: { type: Number, default: 0 },
        },
      ],
      default: [],
    },
    readByClientAt: { type: Date, default: null },
    readByStaffAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

const Message = mongoose.model('Message', messageSchema);
export default Message;
