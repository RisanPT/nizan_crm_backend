import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { notify, getUserIdsByRoles, NOTIFICATION_TYPES } from '../utils/notify.js';
import { uploadChatFiles, previewFor } from '../utils/chatMedia.js';

const CHAT_STAFF_ROLES = ['crm', 'sales', 'accounts', 'manager'];

// Staff who may use the client-chat inbox (mirrors the Flutter sidebar guard
// isFullAccess || crm || accounts || canSeeSales).
export const canSeeClientChat = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (['crm', 'accounts', 'sales'].includes(role)) return true;
  const perms = user?.permissions || [];
  return perms.includes('sales') || perms.some((p) => String(p).startsWith('sales.')) || perms.includes('payables');
};

const messageView = (m) => ({
  _id: String(m._id),
  conversationId: String(m.conversationId),
  senderType: m.senderType,
  senderName: m.senderName || '',
  text: m.text || '',
  attachments: m.attachments || [],
  createdAt: m.createdAt,
  readByStaffAt: m.readByStaffAt,
  readByClientAt: m.readByClientAt,
});

const conversationView = (c) => ({
  _id: String(c._id),
  clientName: c.clientName || '',
  clientPhone: c.clientPhone || '',
  status: c.status,
  lastMessageAt: c.lastMessageAt,
  lastMessagePreview: c.lastMessagePreview || '',
  lastMessageSenderType: c.lastMessageSenderType || '',
  unreadForStaff: c.unreadForStaff || 0,
  unreadForClient: c.unreadForClient || 0,
});

const getOrCreateClientConversation = async (client) => {
  let convo = await Conversation.findOne({ clientUserId: client._id, bookingId: null });
  if (!convo) {
    convo = await Conversation.create({
      clientUserId: client._id,
      clientName: client.name || '',
      clientPhone: client.phone || '',
    });
  }
  return convo;
};

// ─── Client side (protectClient) ─────────────────────────────────────────────
// @route GET /api/chat/client/conversation
export const getClientConversation = async (req, res) => {
  try {
    const convo = await getOrCreateClientConversation(req.client);
    const messages = await Message.find({ conversationId: convo._id }).sort({ createdAt: 1 }).limit(200).lean();
    res.json({ conversation: conversationView(convo), messages: messages.map(messageView) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Uploads any multipart files on the request. Returns `{ attachments }` or sends
// the error response itself and returns null.
const readAttachments = async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return { attachments: [] };
  try {
    return { attachments: await uploadChatFiles(files, req.body) };
  } catch (error) {
    console.error('chat attachment upload failed:', error.message);
    const status = error.status || 502;
    res.status(status).json({
      message: error.status ? error.message : 'Could not upload your attachment. Please try again.',
    });
    return null;
  }
};

// @route POST /api/chat/client/messages
//   JSON { text }  or  multipart { text?, durationMs?, files[] } (photos / voice)
export const postClientMessage = async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    const uploaded = await readAttachments(req, res);
    if (!uploaded) return;
    const { attachments } = uploaded;
    if (!text && attachments.length === 0) { res.status(400); return res.json({ message: 'Message is empty' }); }
    const convo = await getOrCreateClientConversation(req.client);
    const msg = await Message.create({
      conversationId: convo._id,
      senderType: 'client',
      senderId: req.client._id,
      senderName: req.client.name || req.client.phone || 'Client',
      text,
      attachments,
    });
    const preview = previewFor(text, attachments);

    convo.lastMessageAt = new Date();
    convo.lastMessagePreview = preview;
    convo.lastMessageSenderType = 'client';
    convo.unreadForStaff = (convo.unreadForStaff || 0) + 1;
    await convo.save();

    // Surface in the CRM notification stream for client-facing staff.
    try {
      const recipients = await getUserIdsByRoles(CHAT_STAFF_ROLES);
      await notify({
        recipients,
        type: NOTIFICATION_TYPES.CLIENT_MESSAGE,
        title: `New message from ${convo.clientName || convo.clientPhone || 'a client'}`,
        body: preview,
        link: `/client-chat/${convo._id}`,
        bookingId: convo.bookingId || null,
      });
    } catch (e) {
      console.error('client message notify failed:', e.message);
    }

    res.status(201).json(messageView(msg));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/chat/client/unread — cheap poll that must NOT create a thread
// (otherwise every app-open would spawn an empty conversation in the inbox).
export const getClientUnread = async (req, res) => {
  try {
    const convo = await Conversation.findOne({ clientUserId: req.client._id, bookingId: null })
      .select('unreadForClient')
      .lean();
    res.json({ count: convo?.unreadForClient || 0 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/chat/client/read
export const markClientRead = async (req, res) => {
  try {
    const convo = await Conversation.findOne({ clientUserId: req.client._id, bookingId: null });
    if (convo) {
      convo.unreadForClient = 0;
      await convo.save();
      await Message.updateMany(
        { conversationId: convo._id, senderType: 'staff', readByClientAt: null },
        { $set: { readByClientAt: new Date() } },
      );
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Staff side (protect + guard) ────────────────────────────────────────────
// @route GET /api/chat/conversations?search=&status=
export const getConversations = async (req, res) => {
  try {
    // Only surface threads that actually carry a message — an empty thread is
    // created lazily (e.g. when a client first opens chat) and shouldn't clutter
    // the inbox until someone says something.
    const filter = { lastMessageSenderType: { $nin: ['', null] } };
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const q = String(req.query.search || '').trim();
    if (q) {
      filter.$or = [
        { clientName: { $regex: q, $options: 'i' } },
        { clientPhone: { $regex: q.replace(/\D/g, '') } },
      ];
    }
    const rows = await Conversation.find(filter).sort({ lastMessageAt: -1 }).limit(200).lean();
    res.json(rows.map(conversationView));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/chat/conversations/:id/messages
export const getConversationMessages = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id).lean();
    if (!convo) { res.status(404); return res.json({ message: 'Conversation not found' }); }
    const messages = await Message.find({ conversationId: convo._id }).sort({ createdAt: 1 }).limit(300).lean();
    res.json({ conversation: conversationView(convo), messages: messages.map(messageView) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/chat/conversations/:id/messages
//   JSON { text }  or  multipart { text?, durationMs?, files[] } (photos / voice)
export const postStaffMessage = async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    const convo = await Conversation.findById(req.params.id);
    if (!convo) { res.status(404); return res.json({ message: 'Conversation not found' }); }
    const uploaded = await readAttachments(req, res);
    if (!uploaded) return;
    const { attachments } = uploaded;
    if (!text && attachments.length === 0) { res.status(400); return res.json({ message: 'Message is empty' }); }

    const msg = await Message.create({
      conversationId: convo._id,
      senderType: 'staff',
      senderId: req.user._id,
      senderName: req.user.name || 'Team N',
      text,
      attachments,
    });

    convo.lastMessageAt = new Date();
    convo.lastMessagePreview = previewFor(text, attachments);
    convo.lastMessageSenderType = 'staff';
    convo.unreadForClient = (convo.unreadForClient || 0) + 1;
    if (!convo.assignedStaffId) convo.assignedStaffId = req.user._id;
    await convo.save();

    res.status(201).json(messageView(msg));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/chat/conversations/:id/read
export const markStaffRead = async (req, res) => {
  try {
    const convo = await Conversation.findById(req.params.id);
    if (convo) {
      convo.unreadForStaff = 0;
      await convo.save();
      await Message.updateMany(
        { conversationId: convo._id, senderType: 'client', readByStaffAt: null },
        { $set: { readByStaffAt: new Date() } },
      );
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/chat/unread-count
export const getUnreadCount = async (req, res) => {
  try {
    const agg = await Conversation.aggregate([
      { $group: { _id: null, total: { $sum: '$unreadForStaff' }, threads: { $sum: { $cond: [{ $gt: ['$unreadForStaff', 0] }, 1, 0] } } } },
    ]);
    const row = agg[0] || { total: 0, threads: 0 };
    res.json({ count: row.total, threads: row.threads });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
