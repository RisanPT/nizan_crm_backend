import mongoose from 'mongoose';
import { VISIT_RETENTION_DAYS } from '../utils/websiteVisits.js';

// One anonymous page view on the public website (Team N Website → Overview → Visitors).
// No name, phone, email or IP address is stored — only a random browser id
// the website made up itself. Rows delete themselves after VISIT_RETENTION_DAYS.
const websiteVisitSchema = mongoose.Schema(
  {
    vid: { type: String, required: true }, // random per browser (localStorage)
    sid: { type: String, required: true }, // random per visit (sessionStorage)
    day: { type: String, required: true }, // YYYY-MM-DD in IST
    path: { type: String, default: '/' },
    source: { type: String, default: 'direct' }, // where the visit came from
    medium: { type: String, default: '' }, // utm_medium
    campaign: { type: String, default: '' }, // utm_campaign
    device: { type: String, enum: ['mobile', 'tablet', 'desktop'], default: 'desktop' },
    newVisitor: { type: Boolean, default: false }, // first visit from this browser
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

websiteVisitSchema.index({ day: 1 });
// TTL: MongoDB removes each row this long after it was created.
websiteVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: VISIT_RETENTION_DAYS * 86400 });

const WebsiteVisit = mongoose.model('WebsiteVisit', websiteVisitSchema);

export default WebsiteVisit;
