// The gallery's search and filters, worked out without the database (pure — tests/assetSearch.test.js). The controller
// (controllers/marketingSocialsController.js → listAssets) looks up what a word can mean outside the asset (a shoot's title, location,
// category or crew; the person who added it) and hands it in as `hits`.
//
// SEARCH — every word must be found somewhere on the asset (title, keywords, page, portfolio, owner, its shoot), so each word narrows:
//    bridal reel               both words, anywhere ("reels"/"brides" also find "reel"/"bride")
//    "kerala bride"            these words together, in this order
//    -party                    leave out what mentions "party"
//    #bridal  /  -#bridal      only assets with (or without) the keyword "bridal" itself
//    video, photos, reel…      also mean the media type / asset type ("video" finds every video, whatever its title)
// FILTERS — each list is "any of these" (Videos or Photos), and the lists add up (Videos AND Approved AND Kerala). Keywords can be asked
// as "all of these" (default — each one narrows) or "any of these", and some can be left out.

import mongoose from 'mongoose';
import { normalizeKeyword, keywordAsStored } from './assetKeywords.js';
import { REVIEW_FILTERS } from './workReview.js';

const MAX_LIST = 60;
const MAX_TERMS = 10;
export const ASSET_SORTS = ['relevance', 'newest', 'oldest', 'title'];

export const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const yes = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

/** A query value as a list of strings: one value, repeated values (?a=x&a=y) or a[]=… — never an object; "all" means no filter. */
export const listOf = (v) =>
  [...new Set((Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter((x) => x && x !== 'all'))].slice(0, MAX_LIST);

// words that also name a media type or an asset type
const MEDIA_WORDS = { video: 'video', videos: 'video', clip: 'video', clips: 'video', photo: 'image', photos: 'image', image: 'image', images: 'image', picture: 'image', pictures: 'image', pic: 'image', pics: 'image', design: 'design', designs: 'design', document: 'document', documents: 'document', doc: 'document', docs: 'document', pdf: 'document' };
const KIND_WORDS = { reel: 'reel', reels: 'reel', still: 'still', stills: 'still', film: 'film', films: 'film', carousel: 'carousel', carousels: 'carousel', bts: 'bts', 'behind the scenes': 'bts' };

/** The spellings a word is looked for under: itself, and its singular ("brides" → "bride", "dresses" → "dress", "parties" → "party"). */
export const wordVariants = (text, phrase = false) => {
  const w = String(text);
  const out = [w];
  if (!phrase && w.length > 3 && !/\s/.test(w)) {
    if (/ies$/.test(w) && w.length > 4) out.push(`${w.slice(0, -3)}y`);
    else if (/(s|x|z|ch|sh)es$/.test(w)) out.push(w.slice(0, -2));
    else if (/[^s]s$/.test(w)) out.push(w.slice(0, -1));
  }
  return out;
};

/** The pattern a search word is found by (anywhere, any case). */
export const termRegex = (t) => new RegExp(wordVariants(t.text, t.phrase).map(escapeRx).join('|'), 'i');
// …and at the start of a word (a title "Bridal reel" is a better match for "reel" than "Steel reelings" is)
const wordStartRegex = (t) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${wordVariants(t.text, t.phrase).map(escapeRx).join('|')})`, 'iu');

/**
 * What was typed in the search box: { terms: [{ text, phrase, key }], exclude: [{ text, phrase, key }], keywords: [], notKeywords: [] }.
 * Words of one letter are left out (they would match nearly everything); a "phrase" is kept whole.
 */
export const parseSearchText = (q) => {
  const s = String(q ?? '').slice(0, 300);
  const out = { terms: [], exclude: [], keywords: [], notKeywords: [] };
  const seen = new Set();
  for (const m of s.matchAll(/(-?)(#?)(?:"([^"]*)"?|([^\s",]+))/g)) {
    const [, neg, hash, quoted, bare] = m;
    const phrase = quoted != null;
    const text = String(quoted ?? bare ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (hash) {
      const kw = normalizeKeyword(text);
      if (kw) (neg ? out.notKeywords : out.keywords).push(kw);
      continue;
    }
    // a lone "-" or "#", or a one-letter word, is not something to look for
    // (punctuation around a word is dropped — "bridal." is "bridal" — but a search of punctuation alone is looked for as typed)
    const cleaned = phrase ? text : text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || text;
    if (!cleaned || (!phrase && [...cleaned].length < 2)) continue;
    const key = `${neg ? '-' : ''}${phrase ? '"' : ''}${cleaned}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (neg ? out.exclude : out.terms).push({ text: cleaned, phrase, key: cleaned });
  }
  out.terms = out.terms.slice(0, MAX_TERMS);
  out.exclude = out.exclude.slice(0, MAX_TERMS);
  out.keywords = [...new Set(out.keywords)].slice(0, MAX_TERMS);
  out.notKeywords = [...new Set(out.notKeywords)].slice(0, MAX_TERMS);
  return out;
};

/** True when the search box holds something to look for. */
export const hasText = (text) => !!text && (text.terms.length || text.exclude.length || text.keywords.length || text.notKeywords.length) > 0;

/** The gallery's request, read once: filters, keywords, the search, sort and paging. */
export const parseAssetSearch = (query = {}) => {
  const ids = (v) => listOf(v).filter((x) => mongoose.isValidObjectId(x));
  const keywords = [...new Set([...listOf(query.kw), ...listOf(query.tag)].map(keywordAsStored).filter(Boolean))];
  const notKeywords = [...new Set(listOf(query.notKw).map(keywordAsStored).filter(Boolean))].filter((k) => !keywords.includes(k));
  const text = parseSearchText(query.q);
  const sortAsked = ASSET_SORTS.includes(query.sort) ? query.sort : 'newest';
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 120, 1), 500);
  return {
    stage: listOf(query.stage),
    kind: listOf(query.kind),
    media: listOf(query.media),
    portfolio: listOf(query.portfolio),
    page: listOf(query.page),
    owner: listOf(query.owner),
    shootIds: ids(query.shootId),
    keywords,
    kwMode: query.kwMode === 'any' ? 'any' : 'all',
    notKeywords,
    usable: yes(query.usable),
    final: yes(query.final),
    untagged: yes(query.untagged),
    // the work behind the item (services/workQuality.js): an artist on it (employee id, or "n:name"), the client's review of it
    artist: listOf(query.artist).map(String).filter((k) => mongoose.isValidObjectId(k) || /^n:.+/.test(k)),
    review: listOf(query.review).filter((v) => REVIEW_FILTERS.includes(v)),
    text,
    // "best match" needs words to match; without them it is the newest first
    sort: sortAsked === 'relevance' && !text.terms.length ? 'newest' : sortAsked,
    pageNo: Math.max(parseInt(query.pageNo, 10) || 1, 1),
    limit,
  };
};

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const NO_OWNER = { ownerName: { $in: ['', null] } };

/** Where one search word may be found on an asset. `hit` = { shootIds, userIds } the word found outside the asset. */
export const termClause = (t, hit = {}) => {
  const rx = termRegex(t);
  const or = [{ title: rx }, { tags: rx }, { page: rx }, { portfolio: rx }, { ownerName: rx }];
  if (hit.shootIds?.length) or.push({ shootId: { $in: hit.shootIds.map(oid) } });
  if (hit.userIds?.length) or.push({ ...NO_OWNER, createdBy: { $in: hit.userIds.map(oid) } });
  if (MEDIA_WORDS[t.text]) or.push({ media: MEDIA_WORDS[t.text] });
  if (KIND_WORDS[t.text]) or.push({ kind: KIND_WORDS[t.text] });
  return { $or: or };
};

/**
 * The filter for each part of the request, by name (null = not asked). Kept apart so a facet can be counted with every filter but its
 * own ("Videos 40 · Photos 120" stays visible after picking Videos). `ctx` = { hits: Map<term key, {shootIds,userIds}>,
 * ownerUsers: Map<lower-case owner name, userIds> }.
 */
export const assetClauses = (spec, ctx = {}) => {
  const inList = (field, list) => (list.length ? { [field]: { $in: list } } : null);
  const hits = ctx.hits ?? new Map();
  const ownerUsers = ctx.ownerUsers ?? new Map();
  const t = spec.text ?? { terms: [], exclude: [], keywords: [], notKeywords: [] };
  const text = [
    ...t.terms.map((term) => termClause(term, hits.get(term.key))),
    ...t.exclude.map((term) => ({ $nor: [{ title: termRegex(term) }, { tags: termRegex(term) }, { page: termRegex(term) }, { portfolio: termRegex(term) }] })),
    ...(t.keywords.length ? [{ tags: { $all: t.keywords } }] : []),
    ...(t.notKeywords.length ? [{ tags: { $nin: t.notKeywords } }] : []),
  ];
  return {
    stage: inList('stage', spec.stage),
    kind: inList('kind', spec.kind),
    media: inList('media', spec.media),
    portfolio: inList('portfolio', spec.portfolio),
    page: inList('page', spec.page),
    // the named owner; for assets that name none, the person who added them
    owner: spec.owner.length
      ? {
          $or: spec.owner.flatMap((name) => {
            const users = ownerUsers.get(name.toLowerCase()) ?? [];
            return [{ ownerName: new RegExp(`^${escapeRx(name)}$`, 'i') }, ...(users.length ? [{ ...NO_OWNER, createdBy: { $in: users.map(oid) } }] : [])];
          }),
        }
      : null,
    keywords: spec.keywords.length ? { tags: spec.kwMode === 'any' ? { $in: spec.keywords } : { $all: spec.keywords } } : null,
    notKeywords: spec.notKeywords.length ? { tags: { $nin: spec.notKeywords } } : null,
    usable: spec.usable ? { $or: [{ stage: 'approved' }, { isFinal: true }] } : null,
    final: spec.final ? { isFinal: true } : null,
    untagged: spec.untagged ? { $or: [{ tags: { $exists: false } }, { tags: { $size: 0 } }] } : null,
    shoot: spec.shootIds.length ? { shootId: { $in: spec.shootIds.map(oid) } } : null,
    text: text.length ? { $and: text } : null,
  };
};

/** All the parts of the request but [except], as one filter ({} when nothing is asked). */
export const combineClauses = (clauses, except = []) => {
  const list = Object.entries(clauses).filter(([k, v]) => v && !except.includes(k)).map(([, v]) => v);
  return list.length ? { $and: list } : {};
};

/**
 * How well an asset matches the words searched (for "Best match"): the keyword itself counts most, then a word at the start of a word
 * in the title, then anywhere in the keywords or title, then page / portfolio / owner / shoot. All the words in the title in the order
 * typed adds more. 0 = matched only through something not scored.
 */
export const scoreAsset = (a, text, hits = new Map()) => {
  const title = String(a.title ?? '');
  const tags = a.tags ?? [];
  let s = 0;
  for (const t of text?.terms ?? []) {
    const rx = termRegex(t);
    const variants = wordVariants(t.text, t.phrase);
    if (tags.some((k) => variants.includes(k))) s += 6;
    else if (tags.some((k) => rx.test(k))) s += 3;
    if (wordStartRegex(t).test(title)) s += 4;
    else if (rx.test(title)) s += 2;
    if (rx.test(String(a.page ?? ''))) s += 1.5;
    if (rx.test(String(a.portfolio ?? '')) || rx.test(String(a.ownerName ?? ''))) s += 1;
    const hit = hits.get(t.key);
    if (a.shootId && hit?.shootIds?.some((id) => String(id) === String(a.shootId))) s += 1;
  }
  const words = (text?.terms ?? []).map((t) => t.text);
  if (words.length > 1 && title.toLowerCase().includes(words.join(' '))) s += 3;
  return s;
};

/** Assets in "Best match" order: the score, then the newest. */
export const rankAssets = (assets, text, hits) =>
  assets
    .map((a) => ({ a, s: scoreAsset(a, text, hits) }))
    .sort((x, y) => y.s - x.s || new Date(y.a.createdAt ?? 0) - new Date(x.a.createdAt ?? 0) || String(y.a._id).localeCompare(String(x.a._id)))
    .map((x) => x.a);
