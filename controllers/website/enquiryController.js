// Website enquiries: the public form endpoint and the staff list.
import ServicePackage from '../../models/Package.js';
import AddonService from '../../models/AddonService.js';
import District from '../../models/District.js';
import Region from '../../models/Region.js';
import { priceForLocation } from '../../utils/websitePublic.js';
import WebsiteEnquiry from '../../models/WebsiteEnquiry.js';
import { linkEnquiryToLead } from '../../services/websiteLeads.js';
import { todayIst } from '../../utils/istDate.js';
import { clientIp, createRateLimiter } from '../../utils/rateLimiter.js';
import { ENQUIRY_STATUSES, hashIp, last10, validateEnquiry } from '../../utils/websiteEnquiry.js';
import { isObjectId, userId } from './shared.js';

// Three limits, so faking one (e.g. the forwarded address) still leaves the others.
const perIp = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
const perPhone = createRateLimiter({ windowMs: 24 * 60 * 60_000, max: 3 });
const overall = createRateLimiter({ windowMs: 60 * 60_000, max: 300 });

export const resetEnquiryLimits = () => {
  perIp.reset();
  perPhone.reset();
  overall.reset();
};

const THANKS = 'Thank you! Our team will contact you shortly.';
const tooMany = (res, retryAfterSec) =>
  res
    .set('Retry-After', String(retryAfterSec))
    .status(429)
    .json({ message: 'Too many requests. Please try again a little later, or message us on WhatsApp.' });

// @route POST /api/website/public/enquiry   (no login)
// body: { type, name, phone, email?, venue?, message?, eventDate?, slot?, packageId?, addonIds?,
//         utm?, page?, startedAt, company (honeypot — must be empty) }
export const submitEnquiry = async (req, res) => {
  const ip = clientIp(req);
  const ipCheck = perIp.hit(ip);
  if (!ipCheck.allowed) return tooMany(res, ipCheck.retryAfterSec);
  const all = overall.hit('all');
  if (!all.allowed) return tooMany(res, all.retryAfterSec);

  const v = validateEnquiry(req.body, { todayIso: todayIst() });
  // Bots get the same friendly answer, but nothing is stored.
  if (v.spam) return res.status(201).json({ ok: true, message: THANKS });
  if (!v.ok) return res.status(422).json({ message: v.errors[0], errors: v.errors });

  const phoneCheck = perPhone.hit(last10(v.value.phone));
  if (!phoneCheck.allowed) return tooMany(res, phoneCheck.retryAfterSec);

  // Names come from the CRM, never from the visitor (only website-enabled items count).
  const [pkg, addons, district] = await Promise.all([
    v.value.packageId
      ? ServicePackage.findOne({ _id: v.value.packageId, 'website.show': true })
          .select('name price regionPrices districtPrices')
          .lean()
      : null,
    v.value.addonIds.length
      ? AddonService.find({ _id: { $in: v.value.addonIds }, status: 'active', 'website.show': true })
          .select('name price')
          .lean()
      : [],
    v.value.districtId
      ? District.findOne({ _id: v.value.districtId, status: 'active' }).select('name region').lean()
      : null,
  ]);
  const region = district?.region ? await Region.findById(district.region).select('name').lean() : null;
  const location = district
    ? {
        districtId: district._id,
        regionId: district.region ?? null,
        district: district.name,
        region: region?.name ?? '',
      }
    : null;
  // The total the bride saw, recomputed here from CRM prices (never taken from the browser).
  const quotedTotal = pkg
    ? priceForLocation(pkg, { districtId: location?.districtId, regionId: location?.regionId }) +
      addons.reduce((sum, a) => sum + (Number(a.price) || 0), 0)
    : null;
  const extras = { packageName: pkg?.name ?? '', addonNames: addons.map((a) => a.name), location, quotedTotal };

  const enquiry = await WebsiteEnquiry.create({
    ...v.value,
    packageId: pkg?._id ?? null,
    packageName: extras.packageName,
    addonNames: extras.addonNames,
    districtId: location?.districtId ?? null,
    district: location?.district ?? '',
    region: location?.region ?? '',
    quotedTotal,
    ipHash: hashIp(ip, process.env.JWT_SECRET || ''),
  });

  try {
    const link = await linkEnquiryToLead({ ...v.value }, extras);
    await WebsiteEnquiry.updateOne({ _id: enquiry._id }, { $set: link });
  } catch (e) {
    // The enquiry is safe; staff see it in Team N Website → Enquiries.
    console.error('Website enquiry → Lead failed:', e?.message || e);
    await WebsiteEnquiry.updateOne({ _id: enquiry._id }, { $set: { leadAction: 'failed' } });
  }

  res.status(201).json({ ok: true, message: THANKS });
};

const toClient = (e) => ({
  id: String(e._id),
  type: e.type,
  name: e.name,
  phone: e.phone,
  email: e.email,
  venue: e.venue,
  message: e.message,
  eventDate: e.eventDate,
  slot: e.slot,
  packageName: e.packageName,
  addonNames: e.addonNames,
  district: e.district ?? '',
  region: e.region ?? '',
  quotedTotal: e.quotedTotal ?? null,
  utm: e.utm,
  lead: e.leadId ? { id: String(e.leadId._id ?? e.leadId), name: e.leadId.name, status: e.leadId.status } : null,
  leadAction: e.leadAction,
  status: e.status,
  note: e.note,
  handledBy: e.handledBy?.name ?? null,
  createdAt: e.createdAt,
});

// @route GET /api/website/admin/enquiries?status=new&page=1
export const listEnquiries = async (req, res) => {
  const filter = {};
  if (req.query.status) {
    if (!ENQUIRY_STATUSES.includes(req.query.status)) return res.status(400).json({ message: 'Unknown status.' });
    filter.status = req.query.status;
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 30;
  const [items, total, counts] = await Promise.all([
    WebsiteEnquiry.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('leadId', 'name status')
      .populate('handledBy', 'name')
      .lean(),
    WebsiteEnquiry.countDocuments(filter),
    WebsiteEnquiry.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({
    items: items.map(toClient),
    page,
    pages: Math.ceil(total / limit),
    total,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  });
};

// @route PATCH /api/website/admin/enquiries/:id   body: { status?, note? }
export const updateEnquiry = async (req, res) => {
  if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Enquiry not found.' });
  const $set = { handledBy: userId(req) };
  if (req.body?.status !== undefined) {
    if (!ENQUIRY_STATUSES.includes(req.body.status)) return res.status(400).json({ message: 'Unknown status.' });
    $set.status = req.body.status;
  }
  if (req.body?.note !== undefined) $set.note = String(req.body.note).slice(0, 500);
  const updated = await WebsiteEnquiry.findByIdAndUpdate(req.params.id, { $set }, { new: true })
    .populate('leadId', 'name status')
    .populate('handledBy', 'name')
    .lean();
  if (!updated) return res.status(404).json({ message: 'Enquiry not found.' });
  res.json(toClient(updated));
};
