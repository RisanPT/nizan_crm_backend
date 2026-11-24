// The website's built-in text per section (what visitors see until a section is
// published). Read from data/websiteSeed.json, exported from the website's
// src/data/content. The CRM editor starts from this, so staff change only what
// they need and everything else stays exactly as it is now.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SEED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'websiteSeed.json');

let cache = null;

const load = () => {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    cache = raw.sections ?? raw;
  } catch {
    cache = {}; // no seed file → editors simply start empty
  }
  return cache;
};

/** Built-in text for one section ({} when unknown). */
export function sectionDefaults(key) {
  const d = load()[key];
  if (!d || typeof d !== 'object') return {};
  const copy = JSON.parse(JSON.stringify(d));
  // Comparison cells belong to CRM package ids, which the built-in text cannot
  // know; leave the table out so publishing other Packages-page text never
  // replaces it with empty cells.
  if (key === 'packagesPage') delete copy.comparison;
  return copy;
}
