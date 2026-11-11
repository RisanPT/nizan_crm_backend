// Food cost PER HEAD on a work.
//
// A work has a lead artist and assistants (everyone assigned to the booking — the driver, who
// is listed in the same array, is not a head). Every person's own food bills are placed under
// the work they were eaten for (utils/mealAllocation.js), so a work's food is the sum of what
// each person spent. Per head is that total ÷ the number of heads, and the list of people shows
// who spent what — including the people who were on the work but filed no food.
//
// Pure — tests/perHead.test.js.

const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
const toRupees = (paise) => paise / 100;

/**
 * @param {object} o
 * @param {Array}  o.people  who is assigned to the work: [{ employeeId, name, roleType: 'lead'|'assistant' }]
 * @param {Array}  o.lines   the food lines placed under the work: [{ employeeId, name?, amount }]
 * @returns {{ heads: number, foodPerHead: number|null, people: Array<{ employeeId, name, roleType, assigned, food }> }}
 *   heads        how many people are assigned (the divisor); someone who spent on the work without being
 *                assigned is listed (assigned: false) but is not a head
 *   foodPerHead  the work's food ÷ heads, to the paisa; null when nobody is assigned
 *   people       the assigned people first (lead before assistant, as given), then anyone else who spent
 */
export const perHead = ({ people = [], lines = [] }) => {
  const spent = new Map(); // employeeId → paise
  const names = new Map();
  let totalPaise = 0;
  for (const l of lines) {
    const id = String(l.employeeId ?? '');
    const paise = toPaise(l.amount);
    totalPaise += paise;
    spent.set(id, (spent.get(id) || 0) + paise);
    if (l.name && !names.has(id)) names.set(id, String(l.name));
  }

  const assigned = people.map((p) => ({
    employeeId: String(p.employeeId),
    name: p.name || names.get(String(p.employeeId)) || '',
    roleType: p.roleType === 'lead' ? 'lead' : 'assistant',
    assigned: true,
    food: toRupees(spent.get(String(p.employeeId)) || 0),
  }));
  const known = new Set(assigned.map((p) => p.employeeId));
  const extras = [...spent.keys()]
    .filter((id) => id && !known.has(id))
    .map((id) => ({ employeeId: id, name: names.get(id) ?? '', roleType: '', assigned: false, food: toRupees(spent.get(id)) }));

  const heads = assigned.length;
  return {
    heads,
    foodPerHead: heads > 0 ? Math.round(totalPaise / heads) / 100 : null,
    people: [...assigned, ...extras],
  };
};
