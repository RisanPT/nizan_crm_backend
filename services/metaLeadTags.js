// Meta Lead Ads leads and their CRM campaign. A lead from Meta names the Meta campaign its ad belongs to (MetaLeadEvent.metaCampaignId);
// once a CRM campaign carries that Meta ID — linked or added from the sync's list, matched by its title in a sync or a file import,
// created by an import, or the ID typed on the campaign — the leads that came before it take that campaign too (only leads that have
// none yet: a campaign the team chose by hand is never changed).
import Lead from '../models/Lead.js';
import MetaLeadEvent from '../models/MetaLeadEvent.js';

/** → how many CRM leads were given the campaign. Never throws (a lead's campaign is a convenience, not worth failing a save for). */
export const tagMetaLeads = async (metaCampaignId, campaignId) => {
  const metaId = String(metaCampaignId ?? '').trim();
  if (!metaId || !campaignId) return 0;
  try {
    // the Meta campaign is this CRM campaign (one Meta ID, one campaign): its noted leads say so
    await MetaLeadEvent.updateMany({ metaCampaignId: metaId }, { $set: { campaignId } });
    // only leads this Meta campaign MADE — a number that was already a lead (came from elsewhere first) keeps its own story
    const ids = (await MetaLeadEvent.find({ metaCampaignId: metaId, leadId: { $ne: null }, status: 'created' }).select('leadId').lean()).map((e) => e.leadId);
    if (!ids.length) return 0;
    const r = await Lead.updateMany({ _id: { $in: ids }, $or: [{ campaignId: null }, { campaignId: { $exists: false } }] }, { $set: { campaignId } });
    return r.modifiedCount ?? 0;
  } catch (err) {
    console.error('[Meta leads] could not give leads their campaign:', err?.message ?? err);
    return 0;
  }
};
