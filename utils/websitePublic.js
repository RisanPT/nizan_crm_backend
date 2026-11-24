// Pure shapers (no database): turn CRM documents into what the public website
// may see. Anything not listed here never leaves the server.

const image = (img) =>
  img?.url
    ? { url: img.url, width: img.width ?? null, height: img.height ?? null, alt: img.alt ?? '' }
    : null;

const byWebsiteOrder = (a, b) => {
  const oa = a.website?.sortOrder ?? a.sortOrder ?? Number.POSITIVE_INFINITY;
  const ob = b.website?.sortOrder ?? b.sortOrder ?? Number.POSITIVE_INFINITY;
  if (oa !== ob) return oa - ob;
  return String(a.name).localeCompare(String(b.name));
};

// Package price for a wedding location — the same rule as bookingController
// (computeBasePackagePrice): district price, else region price, else base price.
export function priceForLocation(p, { districtId = null, regionId = null } = {}) {
  if (districtId) {
    const d = (p.districtPrices ?? []).find((x) => String(x.district) === String(districtId));
    if (d) return Number(d.price) || 0;
  }
  if (regionId) {
    const r = (p.regionPrices ?? []).find((x) => String(x.region) === String(regionId));
    if (r) return Number(r.price) || 0;
  }
  return Number(p.price) || 0;
}

const priceMap = (rows, key) =>
  Object.fromEntries(
    (rows ?? [])
      .filter((x) => x?.[key] && Number.isFinite(Number(x.price)))
      .map((x) => [String(x[key]?._id ?? x[key]), Number(x.price)])
  );

export function toPublicPackage(p) {
  const w = p.website || {};
  const regionPrices = priceMap(p.regionPrices, 'region');
  const districtPrices = priceMap(p.districtPrices, 'district');
  const all = [Number(p.price) || 0, ...Object.values(regionPrices), ...Object.values(districtPrices)];
  return {
    id: String(p._id),
    name: p.name,
    price: p.price,
    // Prices by wedding location: { regionId: price } and { districtId: price }.
    regionPrices,
    districtPrices,
    priceMin: Math.min(...all),
    priceMax: Math.max(...all),
    advanceAmount: p.advanceAmount ?? null,
    tagline: w.tagline || '',
    description: w.description || p.description || '',
    idealFor: w.idealFor || '',
    features: Array.isArray(w.features) ? w.features : [],
    durationLabel: w.durationLabel || '',
    highlighted: Boolean(w.highlighted),
    priceFrom: Boolean(w.priceFrom),
    coverImage: image(w.coverImage),
  };
}

export function toPublicAddon(a) {
  return {
    id: String(a._id),
    name: a.name,
    price: a.price,
    description: a.website?.description || a.description || '',
  };
}

export const sortForWebsite = (list) => [...list].sort(byWebsiteOrder);

/** Active regions with their active districts, for the wedding-location picker. Names + ids only. */
export function toPublicLocations(regions = [], districts = []) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  return [...regions]
    .sort(byName)
    .map((r) => ({
      id: String(r._id),
      name: r.name,
      districts: districts
        .filter((d) => String(d.region) === String(r._id))
        .sort(byName)
        .map((d) => ({ id: String(d._id), name: d.name })),
    }))
    .filter((r) => r.districts.length > 0);
}

export function toPublicGalleryItem(g) {
  return {
    id: String(g._id),
    image: image({ ...g.image, alt: g.alt }),
    alt: g.alt,
    title: g.title || '',
    description: g.description || '',
    category: g.category,
    featuredOnHome: Boolean(g.featuredOnHome),
  };
}
