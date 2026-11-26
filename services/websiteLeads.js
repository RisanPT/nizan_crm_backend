// Turns a website enquiry into CRM Lead activity.
// Same rule as Sales → Leads: one mobile number = one Lead. A number that
// already has a Lead gets a note on that Lead instead of a duplicate.
import Lead from '../models/Lead.js';
import {
  notify,
  getUserIdsByRoles,
  getSalesLeadIds,
  NOTIFICATION_TYPES,
} from '../utils/notify.js';
import { last10, leadFromEnquiry, leadRemarks } from '../utils/websiteEnquiry.js';

// Matches a stored number ending in these 10 digits whatever its formatting
// (same pattern as controllers/leadController.js findDuplicateLead).
const phoneTailRx = (key) => new RegExp(`${key.split('').join('[^0-9]*')}[^0-9]*$`);

const findLeadByPhone = async (phone) => {
  const key = last10(phone);
  if (key.length !== 10) return null;
  const rx = phoneTailRx(key);
  return Lead.findOne({ $or: [{ phone: rx }, { alternateNumber: rx }] })
    .select('name phone status assignedTo')
    .lean();
};

// Numbers being linked right now — stops a double submit making two Leads.
const linking = new Set();

/**
 * → { leadId, leadAction: 'created' | 'existing' }
 * Throws on database errors (the caller keeps the enquiry and marks it 'failed').
 */
export async function linkEnquiryToLead(enquiry, extras = {}) {
  const key = last10(enquiry.phone) || enquiry.phone;
  while (linking.has(key)) await new Promise((r) => setTimeout(r, 50));
  linking.add(key);
  try {
    const existing = await findLeadByPhone(enquiry.phone);
    const managers = await getSalesLeadIds();

    if (existing) {
      await Lead.updateOne(
        { _id: existing._id },
        {
          $push: {
            auditLog: {
              action: 'website_enquiry',
              byName: 'Website',
              note: leadRemarks(enquiry, extras).slice(0, 1000),
              at: new Date(),
            },
          },
        },
      );
      const recipients = [...new Set([String(existing.assignedTo ?? ''), ...managers.map(String)])].filter(Boolean);
      await notify({
        recipients,
        type: NOTIFICATION_TYPES.NEW_LEAD,
        title: 'Website enquiry from an existing lead',
        body: `${existing.name} sent a ${enquiry.type === 'booking' ? 'booking request' : 'message'} from the website.`,
        leadId: existing._id,
      });
      return { leadId: existing._id, leadAction: 'existing' };
    }

    const lead = await Lead.create(leadFromEnquiry(enquiry, extras));
    await notify({
      recipients: managers,
      type: NOTIFICATION_TYPES.NEW_LEAD,
      title: 'New lead from the website',
      body: `${lead.name} sent a ${enquiry.type === 'booking' ? 'booking request' : 'message'} from the website.`,
      leadId: lead._id,
    });
    return { leadId: lead._id, leadAction: 'created' };
  } finally {
    linking.delete(key);
  }
}
