import mongoose from 'mongoose';
import City from '../models/City.js';
import Country from '../models/Country.js';
import { DERIVED_MARKET_KEYS, marketFields, readIdInput, readMarketFields } from '../utils/marketGeo.js';

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/// Turns the marketing details a client sent on a lead into consistent stored values, in place on [data] (a copy of the request
/// body). [existing] is the lead being edited (none for a new one). Rules (utils/marketGeo.js):
///   • country / city names sent by the client are dropped — they are derived from the ids;
///   • neither countryId nor cityId sent → the lead's place is left alone;
///   • a city brings its own country (and a country that disagrees with it is refused);
///   • a country alone clears the city, unless the lead's current city is in that country;
///   • both empty → place cleared;
///   • the plain fields (WhatsApp, e-mail, budget, …) change only when sent, and are refused in plain words when wrong;
///   • a budget with no currency takes the country's currency, else keeps the lead's.
/// Throws an error with status 400 for anything it refuses.
export const applyLeadMarkets = async (data, existing = null) => {
  for (const key of DERIVED_MARKET_KEYS) delete data[key];

  // the e-mail is checked only when it changed, so an old lead with a sloppy address can still be saved
  if ('email' in data && existing && String(data.email ?? '').trim() === String(existing.email ?? '').trim()) delete data.email;

  const fields = readMarketFields(data);
  if (fields.error) throw bad(fields.error);
  for (const key of ['whatsapp', 'email', 'budget', 'budgetCurrency', 'language', 'referralPartner', 'creative']) delete data[key];
  Object.assign(data, fields.set);

  const countryIn = readIdInput(data, 'countryId');
  const cityIn = readIdInput(data, 'cityId');
  delete data.countryId;
  delete data.cityId;

  let country = null;
  if (countryIn.present || cityIn.present) {
    const valid = (id, what) => {
      if (!mongoose.isValidObjectId(id)) throw bad(`Choose a ${what} from the list.`);
    };
    let city = null;
    if (cityIn.id) {
      valid(cityIn.id, 'city');
      city = await City.findById(cityIn.id).populate({ path: 'country', select: 'name currency' }).lean();
      if (!city) throw bad('That city is not in the list.');
      country = city.country;
      if (countryIn.id) {
        valid(countryIn.id, 'country');
        if (String(country?._id) !== countryIn.id) throw bad(`${city.name} is not in the country you chose.`);
      }
    } else if (countryIn.id) {
      valid(countryIn.id, 'country');
      country = await Country.findById(countryIn.id).select('name currency').lean();
      if (!country) throw bad('That country is not in the list.');
      // a country alone keeps the lead's city only when that city is in it
      if (!cityIn.present && existing?.cityId) {
        const kept = await City.findById(existing.cityId).select('name country').lean();
        if (kept && String(kept.country) === countryIn.id) city = kept;
      }
    }
    Object.assign(data, marketFields(country, city));
  }

  // a budget without a currency is read in the country's currency: the one chosen in this same request, else the lead's own currency
  // (never flipped by a budget edit alone), else its current country's
  const budgetSent = 'budget' in fields.set && fields.set.budget != null;
  if (budgetSent && !('budgetCurrency' in fields.set)) {
    let currency = '';
    if (country?.currency && (countryIn.present || cityIn.present)) currency = country.currency;
    else if (existing?.budgetCurrency) currency = existing.budgetCurrency;
    else if (existing?.countryId) currency = (await Country.findById(existing.countryId).select('currency').lean())?.currency ?? '';
    if (currency) data.budgetCurrency = currency;
  }
  if ('budget' in fields.set && fields.set.budget == null && !('budgetCurrency' in fields.set)) data.budgetCurrency = '';
};
