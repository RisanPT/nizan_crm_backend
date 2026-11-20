import { leadDay, leadBrand } from './marketingLeadStages.js';
import { isBooked } from './marketingOutcomes.js';

// Team Dashboard → Performance: lead-to-booking per member. Pure (tests/marketingTeamLeads.test.js). It adds no rule of its own — a lead,
// its day, its brand and "booked" are the Lead Report's (utils/marketingLeadStages.js, utils/marketingOutcomes.js):
//   a lead counts in the range by the day it ARRIVED (leadDay) and for its brand (leadBrand); it is BOOKED when it is linked to a live
//   booking (isBooked — a Converted lead whose booking was cancelled is not a booking). A member's leads are the CRM leads ASSIGNED to the
//   member's login (Lead.assignedTo = the member's User). Lead → booking = booked ÷ leads × 100, one decimal — the Lead Report's
//   conversion rate, for one person.
//   No login linked → the member has no lead figures at all ("—"); a login with no lead in the range → 0 leads and no rate ("—").

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Map<userId, { leads, booked, rate }> for the leads assigned to [userIds] that arrived in { from, to } for the brand. `ctx` = the Lead
 * Report's booking context (services/marketingLeadReportData.js bookingContext). `leads` may hold more than the range (the loader reads
 * a window); only the range is counted.
 */
export const leadConversionByUser = ({ leads = [], userIds = [], from, to, brand = 'all', ctx = {} }) => {
  const out = new Map(userIds.map((u) => [idOf(u), { leads: 0, booked: 0, rate: null }]));
  for (const l of leads) {
    const row = out.get(idOf(l.assignedTo));
    if (!row) continue;
    const day = leadDay(l);
    if (!(day >= from && day <= to)) continue;
    if (brand && brand !== 'all' && leadBrand(l) !== brand) continue;
    row.leads += 1;
    if (isBooked(l, ctx)) row.booked += 1;
  }
  for (const row of out.values()) row.rate = row.leads > 0 ? round1((row.booked / row.leads) * 100) : null;
  return out;
};
