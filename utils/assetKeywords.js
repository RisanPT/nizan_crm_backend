// Keywords on gallery assets (stored in MarketingAsset.tags) — one spelling for each keyword, whoever types it and however they type it
// (pure — tests/assetKeywords.test.js).
//
//  • "Bridal", " bridal ", "#Bridal" and "BRIDAL." are the same keyword: "bridal".
//  • A keyword may hold spaces ("kerala bride", "hair & makeup"); a comma, a semicolon, a new line or a # starts the next one — so
//    pasting "bridal, reel; #kerala #bride" gives four keywords.
//  • Duplicates are dropped (the first spelling's place is kept); nothing is cut short behind the person's back: a keyword that is too
//    long, or more keywords than an asset may carry, is refused with the reason.

export const MAX_KEYWORDS = 50;
export const MAX_KEYWORD_LEN = 40;

const fail = (message, field = 'tags') => ({ ok: false, message, field });
// the punctuation a keyword never starts or ends with (inside it is kept: "pre-wedding", "hair & makeup", "3.0")
const EDGE = /^[\s"'`.,;:!?()[\]{}<>|\\/*~^=+-]+|[\s"'`.,;:!?()[\]{}<>|\\/*~^=+-]+$/g;

/** The one spelling of a keyword: no leading #, single spaces, no stray punctuation at either end, lower case. '' when nothing is left. */
export const normalizeKeyword = (raw) => {
  if (raw == null || typeof raw === 'object') return '';
  return String(raw).normalize('NFKC').replace(/^[\s#]+/, '').replace(/\s+/g, ' ').replace(EDGE, '').toLowerCase();
};

/** The pieces typed or pasted: a list (each item may itself hold several), or one string. Separators: , ; new line, tab and #. */
export const splitKeywords = (input) => {
  const out = [];
  for (const item of Array.isArray(input) ? input : [input]) {
    if (item == null || typeof item === 'object') continue;
    for (const piece of String(item).split(/[,;\n\r\t]+/)) out.push(...piece.split('#'));
  }
  return out;
};

/**
 * The keywords to save: normalized, without duplicates, in the order typed. Refused (with the reason) when one is longer than
 * MAX_KEYWORD_LEN or there are more than [max].
 */
export const cleanKeywords = (input, { max = MAX_KEYWORDS } = {}) => {
  const seen = new Set();
  const value = [];
  for (const piece of splitKeywords(input)) {
    const k = normalizeKeyword(piece);
    if (!k || seen.has(k)) continue;
    if (k.length > MAX_KEYWORD_LEN) return fail(`Keep each keyword to ${MAX_KEYWORD_LEN} characters — "${k.slice(0, 24)}…" has ${k.length}. Split it with a comma.`);
    seen.add(k);
    value.push(k);
  }
  if (value.length > max) return fail(`An asset can carry up to ${max} keywords — this has ${value.length}. Remove ${value.length - max}.`);
  return { ok: true, value };
};

/** A keyword as a filter names it: exactly as stored (keywords saved before this module may still hold a # or other punctuation). */
export const keywordAsStored = (v) => (v == null || typeof v === 'object' ? '' : String(v).trim().toLowerCase());

/** [tags] with [from] renamed to [to] — merged into [to] when the asset already has it (its first place is kept). */
export const renameKeyword = (tags, from, to) => [...new Set((tags ?? []).map((t) => (t === from ? to : t)))];

/** [tags] after taking [remove] away and adding [add] (to the end, never twice). */
export const applyKeywordChange = (tags, add = [], remove = []) => {
  const drop = new Set(remove);
  const kept = (tags ?? []).filter((t) => !drop.has(t));
  return [...new Set([...kept, ...add.filter((k) => !drop.has(k))])];
};

/**
 * Suggestions for what is being typed, from the library's keywords ({ keyword, count }): those starting with it (or with a word
 * starting with it) first, then those containing it; the most used first within each. Empty [typed] = the most used.
 */
export const rankKeywordSuggestions = (rows, typed, limit = 12) => {
  const k = normalizeKeyword(typed);
  const byUse = (a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword);
  if (!k) return [...rows].sort(byUse).slice(0, limit);
  const starts = [];
  const contains = [];
  for (const r of rows) {
    if (r.keyword === k || r.keyword.startsWith(k) || r.keyword.split(/[\s-]+/).some((w) => w.startsWith(k))) starts.push(r);
    else if (r.keyword.includes(k)) contains.push(r);
  }
  // the exact keyword first of all, so "bride" is offered before "bride to be"
  const exact = (a, b) => (b.keyword === k) - (a.keyword === k);
  return [...starts.sort((a, b) => exact(a, b) || byUse(a, b)), ...contains.sort(byUse)].slice(0, limit);
};
