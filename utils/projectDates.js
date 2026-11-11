// The dates a client sends for a project (its start and its end). The app groups projects by how long
// they run — mini (7 days – 1 month), moderate (1 – 3 months), main (3 months and more) — so these two
// dates matter: a start that is after the end would put a project in the wrong group.
//
// A date arrives as 'YYYY-MM-DD' or an ISO instant. '' or null for the END date means "no end date".
//
// Pure — tests/projectDates.test.js.

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/// A client's date as a Date (a plain day is that day at 00:00 UTC), null for ''/null, undefined when
/// the key was not sent, or NaN-date for a value that is not a date.
const read = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(DAY_ONLY.test(String(v)) ? `${v}T00:00:00.000Z` : v);
  return d;
};

const day = (d) => d.toISOString().slice(0, 10);

/**
 * Checks and cleans the start / end dates of a create or an edit.
 * @param {object} sent      { startDate?, endDate? } as the client sent them
 * @param {object} [existing] the project's stored { startDate, endDate } (for an edit)
 * @returns {{ error: string } | { startDate?: Date, endDate?: Date|null }}
 *   only the keys that were sent come back; an empty end date comes back as null (cleared)
 */
export const checkProjectDates = (sent, existing = {}) => {
  const start = read(sent.startDate);
  const end = read(sent.endDate);
  if (start === null) return { error: 'A project needs a start date.' };
  if (start && Number.isNaN(start.getTime())) return { error: 'The start date is not a valid date.' };
  if (end && Number.isNaN(end.getTime())) return { error: 'The end date is not a valid date.' };

  const effStart = start ?? (existing.startDate ? new Date(existing.startDate) : null);
  const effEnd = end === undefined ? (existing.endDate ? new Date(existing.endDate) : null) : end;
  if (effStart && effEnd && day(effEnd) < day(effStart)) return { error: 'The end date is before the start date.' };

  const out = {};
  if (start !== undefined) out.startDate = start;
  if (end !== undefined) out.endDate = end;
  return out;
};
