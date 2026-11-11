import mongoose from 'mongoose';
import MonthlyObjective from '../models/MonthlyObjective.js';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import { seesAllProjects, escapeRegex } from '../utils/projectAccess.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';
import {
  RESULTS, UNSCORED_RESULTS, istMonthOf, prevMonth, nextMonth, compareMonth, parseMonth, validateObjectiveInput,
  mergeKeyResults, validateCheckIn, progressOf, summarize, carryOverPlan, spanInfo, buildSpan, suggestedResult, planChanges, isReadyToClose,
  trendMonths, trendSeries, TREND_DEFAULT_MONTHS,
} from '../utils/monthlyObjectives.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';
import { canViewDepartment, canManageDepartment, rightsFor, mayAddToMonth } from '../utils/monthlyObjectiveAccess.js';

// Monthly objectives per department (utils/monthlyObjectives.js has the rules). A department's head plans its month; its members
// see it; the people who see every company project (and the CEO, read-only) see every department's.

// A new objective can be touched up freely for a day; after that, once its month has started, changing the plan needs a reason.
const PLAN_GRACE_MS = 24 * 60 * 60 * 1000;
const planLocked = (o) => compareMonth({ year: o.year, month: o.month }, istMonthOf()) <= 0 && Date.now() - new Date(o.createdAt ?? 0).getTime() > PLAN_GRACE_MS;

const idStr = (v) => (v == null ? '' : String(v._id ?? v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ''));
const fail = (res, status, message, code) => res.status(status).json({ message, ...(code ? { code } : {}) });

/// Who is asking, as plain data for the access rules: which departments they lead and belong to.
const loadMonthlyAccess = async (user) => {
  const role = String(user?.role ?? '').trim().toLowerCase();
  const who = {
    full: await seesAllProjects(user),
    viewOnly: role === 'ceo',
    employeeId: user?.employeeId ? idStr(user.employeeId) : '',
    headDeptIds: new Set(),
    memberDeptIds: new Set(),
  };
  // Heading: named as a department's head on the Departments screen (an Employee), or flagged a head and in that department.
  if (who.employeeId) {
    for (const d of await Department.find({ head: who.employeeId, active: { $ne: false } }).select('_id').lean()) {
      who.headDeptIds.add(idStr(d._id));
      who.memberDeptIds.add(idStr(d._id));
    }
  }
  const name = await resolveUserDeptName(user);
  if (name) {
    const own = await Department.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), active: { $ne: false } }).select('_id').lean();
    if (own) {
      who.memberDeptIds.add(idStr(own._id));
      if (user?.isDepartmentHead === true) who.headDeptIds.add(idStr(own._id));
    }
  }
  return who;
};

/// An objective as the app receives it: progress worked out, and what this person may do to it.
const present = (o, who) => {
  const rights = rightsFor(who, o);
  return {
    id: idStr(o._id),
    departmentId: idStr(o.departmentId),
    departmentName: o.departmentName,
    year: o.year,
    month: o.month,
    objective: o.objective,
    description: o.description ?? '',
    priority: o.priority,
    ownerId: o.ownerId ? idStr(o.ownerId) : null,
    ownerName: o.ownerName ?? '',
    keyResults: (o.keyResults ?? []).map((k) => ({
      id: k.id,
      title: k.title,
      kind: k.kind ?? 'number',
      metric: k.metric ?? '',
      unit: k.unit ?? '',
      targetValue: k.targetValue,
      currentValue: k.currentValue ?? 0,
      completed: k.completed === true,
      completedAt: k.completedAt ?? null,
      completedByName: k.completedByName ?? '',
      checkIns: (k.checkIns ?? []).slice(-5).map((c) => ({ value: c.value, completed: c.completed === true, at: c.at, byName: c.byName ?? '' })),
    })),
    progress: progressOf(o),
    // every key result is done and it is still open: the head can close it as achieved with one tap
    readyToClose: isReadyToClose(o),
    // "Month 2 of 3" for an objective that runs several months; null for an ordinary one
    span: spanInfo(o),
    // what the progress points to — the close-out starts there, and choosing another result needs a note
    suggestedResult: o.result ? null : suggestedResult(o),
    result: o.result ?? null,
    resultNote: o.resultNote ?? '',
    closedAt: o.closedAt ?? null,
    progressAtClose: o.progressAtClose ?? null,
    overridden: o.overridden === true,
    planLocked: planLocked(o),
    // given to this person (so the app can say "You" and list it under "Assigned to you")
    assignedToMe: !!who.employeeId && !!o.ownerId && idStr(o.ownerId) === who.employeeId,
    changes: (o.changes ?? []).slice(-10).map((c) => ({ at: c.at, byName: c.byName ?? '', reason: c.reason ?? '', summary: c.summary ?? [] })),
    carriedFrom: !!o.carriedFromId,
    carriedTo: !!o.carriedToId,
    updatedAt: o.updatedAt,
    access: rights,
  };
};

const loadObjective = async (req, res) => {
  if (!isId(req.params.id)) {
    fail(res, 404, 'Objective not found');
    return null;
  }
  const o = await MonthlyObjective.findById(req.params.id);
  if (!o) {
    fail(res, 404, 'Objective not found');
    return null;
  }
  return o;
};

/// Who is doing this, and when — stamped on a key result that becomes done.
const whoDidIt = (req) => ({ at: new Date(), by: req.user._id, byName: req.user.name ?? '' });

/// Every key result just became done: tell the department's head (not the person who did it) that it can be closed as achieved.
const tellHeadReady = async (o, actor) => {
  try {
    const dept = await Department.findById(o.departmentId).select('head').lean();
    if (!dept?.head) return; // no head, nobody to tell
    const heads = await getUserIdsByEmployeeIds([dept.head]);
    const who = actor?.name ? ` (${actor.name} reported the last one)` : '';
    await notify({
      recipients: heads,
      type: NOTIFICATION_TYPES.MONTHLY_OBJECTIVE_READY,
      title: `Ready to close: ${o.objective}`,
      body: `Every key result of “${o.objective}” in ${o.departmentName} is done${who}. Close it as achieved, or leave it open.`,
      link: '/monthly-objectives',
      excludeUserId: actor?._id ?? null,
    });
  } catch {
    // telling the head is a courtesy: it never fails the report that triggered it
  }
};

// @desc    Every department's objectives for a month (the ones this person may see), with how each is doing
// @route   GET /api/monthly-objectives?year=&month=
export const getMonthlyObjectives = async (req, res) => {
  try {
    const parsed = parseMonth(req.query.year, req.query.month);
    if (!parsed.ok) return fail(res, 400, parsed.message);
    const month = parsed.value;
    const current = istMonthOf();
    const who = await loadMonthlyAccess(req.user);

    // Every active department — one with nothing set is still listed, so a gap is seen, not hidden.
    const all = await Department.find({ active: { $ne: false } }).populate('head', 'name').sort({ division: 1, name: 1 }).lean();
    const visible = all.filter((d) => canViewDepartment(who, d._id));
    const ids = visible.map((d) => d._id);
    const before = prevMonth(month);

    const [objectives, last, assigned] = await Promise.all([
      MonthlyObjective.find({ ...month, departmentId: { $in: ids } }).sort({ order: 1, createdAt: 1 }).lean(),
      MonthlyObjective.find({ ...before, departmentId: { $in: ids } }).select('departmentId result keyResults').lean(),
      // What has been given to this person — wherever it sits. Being the owner of an objective is enough to see it (and to report on
      // it), even in a department they are not part of; the rest of that department stays out of sight.
      who.employeeId ? MonthlyObjective.find({ ...month, ownerId: who.employeeId }).sort({ departmentName: 1, order: 1, createdAt: 1 }).lean() : [],
    ]);

    const departments = visible.map((d) => {
      const mine = objectives.filter((o) => idStr(o.departmentId) === idStr(d._id));
      const theirLast = last.filter((o) => idStr(o.departmentId) === idStr(d._id));
      return {
        departmentId: idStr(d._id),
        name: d.name,
        key: d.key,
        division: d.division,
        head: d.head ? { id: idStr(d.head), name: d.head.name } : null,
        canManage: canManageDepartment(who, d._id),
        // their own department (led or belonged to) — listed first, and marked, so a team finds its own month at once
        member: who.memberDeptIds.has(idStr(d._id)),
        objectives: mine.map((o) => present(o, who)),
        summary: summarize(mine),
        lastMonth: summarize(theirLast),
      };
    });
    // own department(s) first; otherwise the order stays as it was (stable sort)
    departments.sort((a, b) => Number(b.member) - Number(a.member));

    res.json({
      year: month.year,
      month: month.month,
      isCurrent: month.year === current.year && month.month === current.month,
      current,
      previous: before,
      next: nextMonth(month),
      departments,
      assigned: assigned.map((o) => present(o, who)),
      totals: {
        departments: departments.length,
        withObjectives: departments.filter((d) => d.summary.count > 0).length,
        objectives: departments.reduce((s, d) => s + d.summary.count, 0),
        avgProgress: summarize(objectives).avgProgress,
        closed: departments.reduce((s, d) => s + d.summary.closed, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    How the last few months went, for the whole company and for each department this person may see
// @route   GET /api/monthly-objectives/trend?year=&month=&months=6   (the months END with the one asked for; default: this month)
export const getMonthlyObjectiveTrend = async (req, res) => {
  try {
    const parsed = parseMonth(req.query.year, req.query.month);
    if (!parsed.ok) return fail(res, 400, parsed.message);
    const asked = req.query.months === undefined || req.query.months === '' ? TREND_DEFAULT_MONTHS : Number(req.query.months);
    if (!Number.isInteger(asked) || asked < 2 || asked > 12) return fail(res, 400, 'Ask for between 2 and 12 months.');
    const months = trendMonths(parsed.value, asked);
    const who = await loadMonthlyAccess(req.user);
    const all = await Department.find({ active: { $ne: false } }).sort({ division: 1, name: 1 }).lean();
    const visible = all.filter((d) => canViewDepartment(who, d._id));
    const objectives = visible.length
      ? await MonthlyObjective.find({ departmentId: { $in: visible.map((d) => d._id) }, $or: months.map((m) => ({ year: m.year, month: m.month })) })
          .select('departmentId year month result keyResults')
          .lean()
      : [];
    res.json({ end: parsed.value, months: trendSeries({ months, objectives, departments: visible.map((d) => ({ id: idStr(d._id), name: d.name })) }) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const ownerSnapshot = async (ownerId) => {
  if (!ownerId) return { ownerId: null, ownerName: '' };
  if (!isId(ownerId)) return { error: 'Choose the owner from the staff list.' };
  const e = await Employee.findById(ownerId).select('name').lean();
  if (!e) return { error: 'That person is not on the staff list.' };
  return { ownerId: e._id, ownerName: e.name ?? '' };
};

// @desc    Add an objective to a department's month
// @route   POST /api/monthly-objectives   { departmentId, year, month, objective, description?, priority?, ownerId?, keyResults? }
export const createMonthlyObjective = async (req, res) => {
  try {
    const parsed = parseMonth(req.body.year, req.body.month);
    if (!parsed.ok) return fail(res, 400, parsed.message);
    const month = parsed.value;
    if (!isId(req.body.departmentId)) return fail(res, 400, 'Choose the department.');
    const dept = await Department.findById(req.body.departmentId).lean();
    if (!dept || dept.active === false) return fail(res, 404, 'Department not found');

    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, dept._id)) return fail(res, 403, `Only the head of ${dept.name} (or an administrator) can set its objectives.`, 'OBJECTIVE_FORBIDDEN');
    if (!mayAddToMonth(who, month, istMonthOf())) return fail(res, 403, 'That month is over. Objectives are planned for this month and the ones ahead.', 'MONTH_CLOSED');

    const input = validateObjectiveInput(req.body);
    if (!input.ok) return fail(res, 400, input.message);
    const owner = await ownerSnapshot(input.value.ownerId);
    if (owner.error) return fail(res, 400, owner.error);

    const span = buildSpan(month, input.value.spanMonths, null);
    if (span.error) return fail(res, 400, span.error);

    const last = await MonthlyObjective.findOne({ departmentId: dept._id, ...month }).sort({ order: -1 }).select('order').lean();
    const doc = await MonthlyObjective.create({
      departmentId: dept._id,
      departmentName: dept.name,
      departmentKey: dept.key,
      ...month,
      objective: input.value.objective,
      description: input.value.description ?? '',
      priority: input.value.priority ?? 'medium',
      ownerId: owner.ownerId,
      ownerName: owner.ownerName,
      order: (last?.order ?? -1) + 1,
      keyResults: mergeKeyResults([], input.value.keyResults ?? [], whoDidIt(req)),
      ...(span.value ? { span: span.value } : {}),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    res.status(201).json(present(doc.toObject(), who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Change an objective (title, description, owner, priority, key results)
// @route   PUT /api/monthly-objectives/:id   (expectedUpdatedAt → 409 OBJECTIVE_CONFLICT if someone else changed it meanwhile)
export const updateMonthlyObjective = async (req, res) => {
  try {
    const o = await loadObjective(req, res);
    if (!o) return;
    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, o.departmentId)) return fail(res, 403, `Only the head of ${o.departmentName} (or an administrator) can change its objectives.`, 'OBJECTIVE_FORBIDDEN');
    if (o.result) return fail(res, 409, 'This objective is closed. Reopen it to change it.', 'OBJECTIVE_CLOSED');
    if (req.body.expectedUpdatedAt && new Date(req.body.expectedUpdatedAt).getTime() !== new Date(o.updatedAt).getTime()) {
      return fail(res, 409, 'Someone else changed this objective. Reload it and try again.', 'OBJECTIVE_CONFLICT');
    }

    const input = validateObjectiveInput(req.body, { partial: true });
    if (!input.ok) return fail(res, 400, input.message);
    const v = input.value;

    const before = { objective: o.objective, keyResults: (o.keyResults ?? []).map((k) => k.toObject?.() ?? k) };
    const nextKeyResults = v.keyResults !== undefined ? mergeKeyResults(before.keyResults, v.keyResults, whoDidIt(req)) : undefined;

    // Once the month has started (and the objective is more than a day old) the plan is something people are being judged against,
    // so changing it needs a reason, which is kept.
    const changes = planLocked(o) ? planChanges(before, { objective: v.objective, keyResults: nextKeyResults }) : [];
    const reason = String(req.body.changeReason ?? '').trim();
    if (changes.length > 0 && reason.length < 3) {
      return fail(res, 400, 'This month has already started. Say why the plan is changing (the reason is kept with the objective).', 'CHANGE_NEEDS_REASON');
    }
    if (reason.length > 500) return fail(res, 400, 'The reason is too long (500 characters at most).');

    let span;
    if (v.spanMonths !== undefined) {
      span = buildSpan({ year: o.year, month: o.month }, v.spanMonths, o.span);
      if (span.error) return fail(res, 400, span.error);
    }

    if (v.objective !== undefined) o.objective = v.objective;
    if (v.description !== undefined) o.description = v.description;
    if (v.priority !== undefined) o.priority = v.priority;
    if (v.ownerId !== undefined) {
      const owner = await ownerSnapshot(v.ownerId);
      if (owner.error) return fail(res, 400, owner.error);
      o.ownerId = owner.ownerId;
      o.ownerName = owner.ownerName;
    }
    if (nextKeyResults !== undefined) o.keyResults = nextKeyResults;
    if (span) o.span = span.value ?? undefined;
    if (changes.length > 0) o.changes.push({ at: new Date(), by: req.user._id, byName: req.user.name ?? '', reason, summary: changes.slice(0, 20) });
    o.updatedBy = req.user._id;
    await o.save();
    res.json(present(o.toObject(), who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Report progress on a key result: the new number, and / or "done"
// @route   PATCH /api/monthly-objectives/:id/key-results/:krId   { value?, completed? }
export const checkInKeyResult = async (req, res) => {
  try {
    const o = await loadObjective(req, res);
    if (!o) return;
    const who = await loadMonthlyAccess(req.user);
    if (!rightsFor(who, o).canCheckIn) return fail(res, 403, 'Only the head of the department, or the person this objective is given to, can report on it.', 'OBJECTIVE_FORBIDDEN');
    if (o.result) return fail(res, 409, 'This objective is closed. Reopen it to report on it.', 'OBJECTIVE_CLOSED');

    const kr = o.keyResults.find((k) => k.id === req.params.krId);
    if (!kr) return fail(res, 404, 'Key result not found');
    const check = validateCheckIn(req.body, kr);
    if (!check.ok) return fail(res, 400, check.message);

    const wasDone = kr.completed === true;
    const wasReady = isReadyToClose(o);
    kr.currentValue = check.value.currentValue;
    kr.completed = check.value.completed;
    if (kr.completed && !wasDone) {
      kr.completedAt = new Date();
      kr.completedBy = req.user._id;
      kr.completedByName = req.user.name ?? '';
    } else if (!kr.completed) {
      kr.completedAt = null;
      kr.completedBy = null;
      kr.completedByName = '';
    }
    kr.checkIns.push({ value: kr.currentValue, completed: kr.completed, at: new Date(), by: req.user._id, byName: req.user.name ?? '' });
    o.updatedBy = req.user._id;
    await o.save();
    if (!wasReady && isReadyToClose(o)) await tellHeadReady(o, req.user);
    res.json(present(o.toObject(), who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Close an objective: achieved / partly / missed at the month's end (a note if that differs from its progress), continues (a
//          several-month objective with months to go), or cancelled / postponed mid-month (a reason is required)
// @route   POST /api/monthly-objectives/:id/close   { result, note? }
export const closeMonthlyObjective = async (req, res) => {
  try {
    const o = await loadObjective(req, res);
    if (!o) return;
    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, o.departmentId)) return fail(res, 403, `Only the head of ${o.departmentName} (or an administrator) can close its objectives.`, 'OBJECTIVE_FORBIDDEN');
    const result = String(req.body.result ?? '').trim().toLowerCase();
    if (!RESULTS.includes(result)) return fail(res, 400, `The result must be one of ${RESULTS.join(', ')}.`);
    const note = String(req.body.note ?? '').trim();
    if (note.length > 1000) return fail(res, 400, 'The note is too long (1000 characters at most).');

    // Dropping or postponing an objective is a decision, so it says why. Ending it differently from what its progress points to
    // (100% yet missed because late; 40% yet achieved because the scope was cut) needs a word on why, too.
    const span = spanInfo(o);
    if (result === 'continued' && !(span && !span.final)) return fail(res, 400, 'Only an objective that runs several months, with months still to go, can continue.', 'RESULT_NOT_ALLOWED');
    if (UNSCORED_RESULTS.includes(result) && note.length < 3) {
      return fail(res, 400, `Say why it was ${result === 'cancelled' ? 'cancelled' : 'postponed'}.`, 'RESULT_NEEDS_REASON');
    }
    const suggested = UNSCORED_RESULTS.includes(result) ? null : suggestedResult(o);
    const overridden = !!suggested && result !== suggested;
    if (overridden && note.length < 3) {
      return fail(res, 400, `This objective is at ${progressOf(o)}%, which points to “${suggested}”. Add a note saying why it ended as “${result}”.`, 'RESULT_NEEDS_REASON');
    }

    o.result = result;
    o.resultNote = note;
    o.progressAtClose = progressOf(o);
    o.overridden = overridden;
    o.closedAt = new Date();
    o.closedBy = req.user._id;
    o.updatedBy = req.user._id;
    await o.save();
    res.json(present(o.toObject(), who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Open a closed objective again
// @route   POST /api/monthly-objectives/:id/reopen
export const reopenMonthlyObjective = async (req, res) => {
  try {
    const o = await loadObjective(req, res);
    if (!o) return;
    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, o.departmentId)) return fail(res, 403, `Only the head of ${o.departmentName} (or an administrator) can reopen its objectives.`, 'OBJECTIVE_FORBIDDEN');
    o.result = null;
    o.resultNote = '';
    o.progressAtClose = null;
    o.overridden = false;
    o.closedAt = null;
    o.closedBy = null;
    o.updatedBy = req.user._id;
    await o.save();
    res.json(present(o.toObject(), who));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete an objective that is still open
// @route   DELETE /api/monthly-objectives/:id
export const deleteMonthlyObjective = async (req, res) => {
  try {
    const o = await loadObjective(req, res);
    if (!o) return;
    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, o.departmentId)) return fail(res, 403, `Only the head of ${o.departmentName} (or an administrator) can delete its objectives.`, 'OBJECTIVE_FORBIDDEN');
    if (o.result) return fail(res, 409, 'A closed objective is part of the month\'s record. Reopen it first if it really has to go.', 'OBJECTIVE_CLOSED');
    // an objective that was carried over from this one no longer points back at it
    await MonthlyObjective.updateMany({ carriedFromId: o._id }, { $set: { carriedFromId: null } });
    await o.deleteOne();
    res.json({ message: 'Objective deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Carry a department's unfinished objectives into the next month (what is left of each unfinished key result)
// @route   POST /api/monthly-objectives/carry-over   { departmentId, year, month, ids? }
export const carryOverObjectives = async (req, res) => {
  try {
    const parsed = parseMonth(req.body.year, req.body.month);
    if (!parsed.ok) return fail(res, 400, parsed.message);
    if (!isId(req.body.departmentId)) return fail(res, 400, 'Choose the department.');
    const dept = await Department.findById(req.body.departmentId).lean();
    if (!dept) return fail(res, 404, 'Department not found');
    const who = await loadMonthlyAccess(req.user);
    if (!canManageDepartment(who, dept._id)) return fail(res, 403, `Only the head of ${dept.name} (or an administrator) can carry its objectives over.`, 'OBJECTIVE_FORBIDDEN');

    const filter = { departmentId: dept._id, ...parsed.value };
    if (Array.isArray(req.body.ids)) filter._id = { $in: req.body.ids.filter(isId) };
    const sources = await MonthlyObjective.find(filter).sort({ order: 1, createdAt: 1 });
    const { items, skipped } = carryOverPlan(sources.map((s) => s.toObject()));

    const to = nextMonth(parsed.value);
    const base = await MonthlyObjective.findOne({ departmentId: dept._id, ...to }).sort({ order: -1 }).select('order').lean();
    let order = (base?.order ?? -1) + 1;
    const created = [];
    for (const item of items) {
      const doc = await MonthlyObjective.create({
        departmentId: dept._id,
        departmentName: dept.name,
        departmentKey: dept.key,
        ...to,
        objective: item.objective,
        description: item.description,
        priority: item.priority,
        ownerId: item.ownerId,
        ownerName: item.ownerName,
        order: order++,
        keyResults: item.keyResults,
        ...(item.span ? { span: item.span } : {}),
        carriedFromId: item.fromId,
        createdBy: req.user._id,
        updatedBy: req.user._id,
      });
      await MonthlyObjective.updateOne({ _id: item.fromId }, { $set: { carriedToId: doc._id } });
      created.push(present(doc.toObject(), who));
    }
    res.json({ created, skipped, toYear: to.year, toMonth: to.month });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

