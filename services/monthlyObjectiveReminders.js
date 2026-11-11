// The two monthly nudges to a department's head: "set this month's objectives" and "close out last month". Run lazily from the
// notification sweep (there is no scheduler in this backend), in IST. Each head gets at most ONE of each per month — a person who
// leads two departments gets one message naming both, because a notification is deduped per person, type and month.
import Department from '../models/Department.js';
import MonthlyObjective from '../models/MonthlyObjective.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';
import { istMonthOf, prevMonth, monthKey, reminderPlan, reminderText } from '../utils/monthlyObjectives.js';

const LINK = '/monthly-objectives'; // the page every team member can open (Company Projects can be switched off per role)

export const runMonthlyObjectiveReminders = async (now = new Date()) => {
  const month = istMonthOf(now);
  const before = prevMonth(month);

  // a department's head is the Employee named on the Departments screen → their login(s)
  const departments = await Department.find({ active: { $ne: false } }).select('name head').lean();
  const withHeads = [];
  for (const d of departments) {
    if (!d.head) continue; // a department with no head has nobody to remind
    withHeads.push({ id: String(d._id), name: d.name, headUserIds: (await getUserIdsByEmployeeIds([d.head])).map(String) });
  }
  if (withHeads.length === 0) return { sent: 0 };

  const [thisRows, lastRows] = await Promise.all([
    MonthlyObjective.find(month).select('departmentId').lean(),
    MonthlyObjective.find(before).select('departmentId result').lean(),
  ]);
  const thisMonth = new Map();
  for (const r of thisRows) thisMonth.set(String(r.departmentId), (thisMonth.get(String(r.departmentId)) ?? 0) + 1);
  const lastMonth = new Map();
  for (const r of lastRows) {
    const k = String(r.departmentId);
    const e = lastMonth.get(k) ?? { count: 0, open: 0 };
    e.count += 1;
    if (!r.result) e.open += 1;
    lastMonth.set(k, e);
  }

  let sent = 0;
  for (const p of reminderPlan({ departments: withHeads, thisMonth, lastMonth })) {
    if (p.set.length) {
      const t = reminderText('set', p.set, month);
      await notify({ recipients: [p.userId], type: NOTIFICATION_TYPES.MONTHLY_OBJECTIVES_SET, title: t.title, body: t.body, link: LINK, forDate: monthKey(month), dedupe: true });
      sent += 1;
    }
    if (p.close.length) {
      const t = reminderText('close', p.close, before);
      await notify({ recipients: [p.userId], type: NOTIFICATION_TYPES.MONTHLY_OBJECTIVES_CLOSE, title: t.title, body: t.body, link: LINK, forDate: monthKey(before), dedupe: true });
      sent += 1;
    }
  }
  return { sent };
};
