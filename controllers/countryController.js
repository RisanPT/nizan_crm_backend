import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import City from '../models/City.js';
import Country from '../models/Country.js';
import Lead from '../models/Lead.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { DEFAULT_MARKETS, readCityForm, readCountryForm } from '../utils/marketGeo.js';

// COUNTRIES AND CITIES — the marketing geography (Country → City) that a lead is placed in. Rules: utils/marketGeo.js.
//
//   GET    /api/countries              { canManage, countries } — each country with its cities (active only; ?all=1 for managers adds the
//                                      switched-off ones and how many leads use each)
//   POST   /api/countries              add a country                       (Marketing Manager / Admin)
//   PUT    /api/countries/:id          rename / re-code / switch off      (a rename reaches the leads that name it)
//   DELETE /api/countries/:id          only when no city and no lead uses it — otherwise switch it off
//   POST   /api/countries/:id/cities   add a city
//   PUT    /api/countries/cities/:cityId   rename / switch off, same rules
//   DELETE /api/countries/cities/:cityId   only when no lead uses it
//
// Everybody who is signed in can read the list (the lead form needs it). The list starts with the Functionality Map's own examples
// (India, UAE, Malaysia) the first time it is asked for while empty; after that the team owns it.

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const denyUnlessManager = (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only the Marketing Manager or Admin can change the countries and cities.', 403);
};

const duplicate = (err) => err?.code === 11000;
const oid = (id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null);

/// Fills an EMPTY list with the starting markets. Safe to run twice at once: the unique indexes make the second one a no-op.
export const ensureDefaultMarkets = async () => {
  if ((await Country.countDocuments({})) > 0) return;
  for (const m of DEFAULT_MARKETS) {
    let country;
    try {
      country = await Country.create({ name: m.name, code: m.code, dialCode: m.dialCode, currency: m.currency });
    } catch (err) {
      if (!duplicate(err)) throw err;
      country = await Country.findOne({ name: m.name }).collation({ locale: 'en', strength: 2 });
    }
    for (const c of m.cities) {
      try {
        await City.create({ name: c.name, state: c.state ?? '', country: country._id });
      } catch (err) {
        if (!duplicate(err)) throw err;
      }
    }
  }
};

const shapeCity = (c, leads) => ({
  id: String(c._id),
  name: c.name,
  state: c.state ?? '',
  status: c.status,
  ...(leads == null ? {} : { leads }),
});

const shapeCountry = (c, cities, leads) => ({
  id: String(c._id),
  name: c.name,
  code: c.code ?? '',
  dialCode: c.dialCode ?? '',
  currency: c.currency ?? '',
  status: c.status,
  ...(leads == null ? {} : { leads }),
  cities,
});

const countBy = async (field, ids) => {
  if (!ids.length) return new Map();
  const rows = await Lead.aggregate([{ $match: { [field]: { $in: ids } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

// @desc   The countries with their cities.
// @route  GET /api/countries
// @access Private
// @returns { canManage, countries: [{ id, name, code, dialCode, currency, status, leads?, cities: [{ id, name, state, status, leads? }] }] }
export const listCountries = asyncHandler(async (req, res) => {
  await ensureDefaultMarkets();
  const all = String(req.query.all ?? '') === '1' && isManagerOrAdmin(req.user);
  const filter = all ? {} : { status: 'active' };
  const [countries, cities] = await Promise.all([
    Country.find(filter).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).lean(),
    City.find(all ? {} : { status: 'active' }).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).lean(),
  ]);
  const [cityLeads, countryLeads] = all
    ? await Promise.all([countBy('cityId', cities.map((c) => c._id)), countBy('countryId', countries.map((c) => c._id))])
    : [null, null];
  const byCountry = new Map();
  for (const c of cities) {
    const k = String(c.country);
    if (!byCountry.has(k)) byCountry.set(k, []);
    byCountry.get(k).push(shapeCity(c, cityLeads ? cityLeads.get(String(c._id)) ?? 0 : null));
  }
  res.json({
    // whether THIS user may change the list (the screen shows its edit buttons by this, so it never disagrees with the server)
    canManage: isManagerOrAdmin(req.user),
    countries: countries.map((c) => shapeCountry(c, byCountry.get(String(c._id)) ?? [], countryLeads ? countryLeads.get(String(c._id)) ?? 0 : null)),
  });
});

// @desc   Add a country.  Body { name, code?, dialCode?, currency? }
// @route  POST /api/countries
// @access Private — Marketing Manager / Admin
export const createCountry = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const form = readCountryForm(req.body);
  if (form.error) bad(res, form.error);
  try {
    const country = await Country.create(form.value);
    res.status(201).json(shapeCountry(country, []));
  } catch (err) {
    if (duplicate(err)) bad(res, `${form.value.name} is already in the list.`, 409);
    throw err;
  }
});

// @desc   Change a country.  Body { name, code?, dialCode?, currency?, status? }  — a new name reaches every lead that names it.
// @route  PUT /api/countries/:id
// @access Private — Marketing Manager / Admin
export const updateCountry = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const country = oid(req.params.id) ? await Country.findById(req.params.id) : null;
  if (!country) bad(res, 'That country is not in the list.', 404);
  const form = readCountryForm({ ...country.toObject(), ...req.body });
  if (form.error) bad(res, form.error);
  const status = req.body?.status ?? country.status;
  if (!['active', 'inactive'].includes(status)) bad(res, 'The status is active or inactive.');
  const renamed = form.value.name !== country.name;
  Object.assign(country, form.value, { status });
  try {
    await country.save();
  } catch (err) {
    if (duplicate(err)) bad(res, `${form.value.name} is already in the list.`, 409);
    throw err;
  }
  if (renamed) await Lead.updateMany({ countryId: country._id }, { $set: { country: country.name } }, { timestamps: false });
  res.json(shapeCountry(country, []));
});

// @desc   Remove a country — only when nothing uses it.
// @route  DELETE /api/countries/:id
// @access Private — Marketing Manager / Admin
export const deleteCountry = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const country = oid(req.params.id) ? await Country.findById(req.params.id) : null;
  if (!country) bad(res, 'That country is not in the list.', 404);
  const [cities, leads] = await Promise.all([City.countDocuments({ country: country._id }), Lead.countDocuments({ countryId: country._id })]);
  if (cities) bad(res, `${country.name} still has ${cities} ${cities === 1 ? 'city' : 'cities'}. Remove them first, or switch the country off.`, 409);
  if (leads) bad(res, `${leads} ${leads === 1 ? 'lead is' : 'leads are'} placed in ${country.name}. Switch it off instead of removing it.`, 409);
  await country.deleteOne();
  res.json({ ok: true });
});

// @desc   Add a city to a country.  Body { name, state? }
// @route  POST /api/countries/:id/cities
// @access Private — Marketing Manager / Admin
export const createCity = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const country = oid(req.params.id) ? await Country.findById(req.params.id).select('name').lean() : null;
  if (!country) bad(res, 'That country is not in the list.', 404);
  const form = readCityForm(req.body);
  if (form.error) bad(res, form.error);
  try {
    const city = await City.create({ ...form.value, country: country._id });
    res.status(201).json(shapeCity(city));
  } catch (err) {
    if (duplicate(err)) bad(res, `${form.value.name} is already a city of ${country.name}.`, 409);
    throw err;
  }
});

// @desc   Change a city.  Body { name, state?, status? } — a new name reaches every lead that names it.
// @route  PUT /api/countries/cities/:cityId
// @access Private — Marketing Manager / Admin
export const updateCity = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const city = oid(req.params.cityId) ? await City.findById(req.params.cityId) : null;
  if (!city) bad(res, 'That city is not in the list.', 404);
  const form = readCityForm({ ...city.toObject(), ...req.body });
  if (form.error) bad(res, form.error);
  const status = req.body?.status ?? city.status;
  if (!['active', 'inactive'].includes(status)) bad(res, 'The status is active or inactive.');
  const renamed = form.value.name !== city.name;
  Object.assign(city, form.value, { status });
  try {
    await city.save();
  } catch (err) {
    if (duplicate(err)) bad(res, `${form.value.name} is already a city in that country.`, 409);
    throw err;
  }
  if (renamed) await Lead.updateMany({ cityId: city._id }, { $set: { city: city.name } }, { timestamps: false });
  res.json(shapeCity(city));
});

// @desc   Remove a city — only when no lead is placed in it.
// @route  DELETE /api/countries/cities/:cityId
// @access Private — Marketing Manager / Admin
export const deleteCity = asyncHandler(async (req, res) => {
  denyUnlessManager(req, res);
  const city = oid(req.params.cityId) ? await City.findById(req.params.cityId) : null;
  if (!city) bad(res, 'That city is not in the list.', 404);
  const leads = await Lead.countDocuments({ cityId: city._id });
  if (leads) bad(res, `${leads} ${leads === 1 ? 'lead is' : 'leads are'} placed in ${city.name}. Switch it off instead of removing it.`, 409);
  await city.deleteOne();
  res.json({ ok: true });
});
