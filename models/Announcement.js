import mongoose from 'mongoose';

export const ANNOUNCEMENT_CATEGORIES = ['announcement', 'event', 'celebration', 'policy'];

// Engagement feed item: company announcements, events (with a date), birthdays /
// work-anniversary celebrations and policy notices. Pull-based feed everyone can
// read; HR posts.
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    category: { type: String, enum: ANNOUNCEMENT_CATEGORIES, default: 'announcement' },
    eventDate: { type: Date, default: null },
    audience: { type: String, default: 'all' }, // 'all' | a department name
    pinned: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedByName: { type: String, default: '' },
  },
  { timestamps: true }
);

announcementSchema.index({ pinned: -1, createdAt: -1 });

const Announcement = mongoose.model('Announcement', announcementSchema);
export default Announcement;
