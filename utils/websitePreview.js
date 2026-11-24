// Pure helper (no database): what a draft preview shows for each section.
// A section with a saved draft shows the draft; otherwise what is live.
const hasContent = (v) => v && typeof v === 'object' && Object.keys(v).length > 0;

export function previewSections(rows = []) {
  const sections = {};
  for (const r of rows) {
    if (hasContent(r.draft)) sections[r.key] = r.draft;
    else if (hasContent(r.published)) sections[r.key] = r.published;
  }
  return sections;
}
