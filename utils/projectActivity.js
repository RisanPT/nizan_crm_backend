// The "Project Activity" list on a project's Overview: what has happened to it, oldest first.
//
// Most of it is worked out from timestamps a project already keeps — when it was created, when each
// department was invited and when it answered — so a project from before this existed shows its
// history straight away. Only what has no timestamp of its own is stored (Project.activity): a change
// of status, a decision on a proposal, a reminder sent to a department.
//
// Pure — tests/projectActivity.test.js.

export const MAX_STORED_ACTIVITY = 100;

/// A department invited within this long of the first of a batch was invited in the same save.
const SAME_BATCH_MS = 60 * 1000;

/// Nobody is reminded about the same invitation more than once in this long.
export const REMINDER_EVERY_MS = 30 * 60 * 1000;

const ms = (d) => (d ? new Date(d).getTime() : NaN);
const idOf = (v) => String(v?._id ?? v ?? '');

/// "on-hold" → "On hold".
export const statusLabel = (s) => {
  const t = String(s ?? '').replace(/-/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};

/**
 * The feed, oldest first: [{ kind, text, by, at }].
 *
 * @param {object}   project  a plain project (createdAt, createdBy, proposedBy, departments, activity)
 * @param {Function} [nameOf] id → the person's name ('' when unknown)
 */
export const buildActivityFeed = (project, nameOf = () => '') => {
  const events = [];
  const born = ms(project?.createdAt);
  const add = (kind, text, at, by = '') => {
    if (!Number.isFinite(ms(at))) return;
    // The invitations are stamped a moment before the project itself is saved: nothing happens to a project before it exists.
    const when = kind !== 'created' && Number.isFinite(born) && ms(at) < born ? project.createdAt : at;
    events.push({ kind, text, by: by || '', at: new Date(when) });
  };

  add('created', project?.proposedBy ? 'Project proposed' : 'Project created', project?.createdAt, nameOf(project?.createdBy));

  // A participant that is the saver's own department is accepted on the spot (invitedAt == respondedAt):
  // nobody was invited and nobody answered, so it makes no line.
  const participants = (project?.departments ?? []).filter(
    (d) => d?.name && d.role !== 'owner' && d.invitedAt && !(d.respondedAt && ms(d.respondedAt) === ms(d.invitedAt)),
  );

  // Invitations sent together read as one line.
  const byTime = [...participants].sort((a, b) => ms(a.invitedAt) - ms(b.invitedAt));
  for (let i = 0; i < byTime.length; ) {
    const start = ms(byTime[i].invitedAt);
    const batch = [];
    while (i < byTime.length && ms(byTime[i].invitedAt) - start <= SAME_BATCH_MS) batch.push(byTime[i++]);
    add(
      'invited',
      batch.length === 1 ? `Invitation sent to ${batch[0].name}` : `Invitations sent to ${batch.length} departments`,
      batch[0].invitedAt,
    );
  }

  for (const d of participants) {
    if (d.status === 'accepted') add('joined', `${d.name} joined the project`, d.respondedAt, nameOf(d.respondedBy));
    if (d.status === 'declined') add('declined', `${d.name} declined the invitation`, d.respondedAt, nameOf(d.respondedBy));
  }

  for (const a of project?.activity ?? []) add(a.kind || 'note', a.text, a.at, a.byName);

  // oldest first; at the same instant the order they were added in stays
  return events.map((e, i) => ({ e, i })).sort((x, y) => ms(x.e.at) - ms(y.e.at) || x.i - y.i).map(({ e }) => e);
};

/// Adds a stored event to a project, keeping only the latest [MAX_STORED_ACTIVITY].
export const recordActivity = (project, kind, text, user, at = new Date()) => {
  if (!Array.isArray(project.activity)) project.activity = [];
  project.activity.push({ kind, text, byName: user?.name ?? '', at });
  if (project.activity.length > MAX_STORED_ACTIVITY) project.activity.splice(0, project.activity.length - MAX_STORED_ACTIVITY);
};

/// How long until a department may be reminded again (0 = now).
export const reminderWaitMs = (remindedAt, now = new Date()) => {
  const last = ms(remindedAt);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + REMINDER_EVERY_MS - ms(now));
};

export { idOf };
