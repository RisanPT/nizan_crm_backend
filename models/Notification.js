import mongoose from 'mongoose';

// One document per recipient (fan-out on write) so every user carries their own
// read state. Time-based follow-up notifications use `forDate` as a dedup key so
// the same due/missed follow-up is never announced twice.
const notificationSchema = mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Event key — see NOTIFICATION_TYPES in utils/notify.js.
    type: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    body: {
      type: String,
      default: '',
    },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      default: null,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
    // Generic in-app deep-link target (a router path, e.g. '/fleet/assignments').
    // Lets any department point a notification at the right screen without adding
    // a dedicated foreign-key field per feature.
    link: {
      type: String,
      default: '',
    },
    // The follow-up date a due/missed notification refers to, so re-running the
    // sweep does not create duplicates for the same scheduled follow-up.
    forDate: {
      type: Date,
      default: null,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    // Who triggered the event (null for system/time-based sweeps).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Fast "my latest notifications" and "my unread" queries.
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, read: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
