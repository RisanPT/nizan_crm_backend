// Who may see and change a department's monthly objectives. Pure (tests/monthlyObjectiveAccess.test.js); the controller builds the
// plain `who` from the database (loadMonthlyAccess in controllers/monthlyObjectiveController.js).
//
//   who = {
//     full:        sees every department and may run any of them — admin, manager, project manager, executive coordinator, or a
//                  role granted planning.manage (the same people who see every company project),
//     viewOnly:    the CEO login — sees everything, changes nothing (the server also refuses its writes, middleware/ceoGuard.js),
//     employeeId:  who they are on the staff list (to recognise an objective's owner),
//     headDeptIds: departments they lead (Set of ids),
//     memberDeptIds: departments they belong to (Set of ids),
//   }

const has = (set, id) => set instanceof Set && set.has(String(id));

/// May they see this department's objectives at all?
export const canViewDepartment = (who, deptId) => !!who.full || has(who.headDeptIds, deptId) || has(who.memberDeptIds, deptId);

/// May they plan this department's month: add, edit, close, carry over, delete?
export const canManageDepartment = (who, deptId) => !who.viewOnly && (!!who.full || has(who.headDeptIds, deptId));

/// What they may do to one objective. A department's head (or a full-access person) manages it; its owner may report progress on it.
export const rightsFor = (who, objective) => {
  const canManage = canManageDepartment(who, objective.departmentId);
  const isOwner = !!who.employeeId && !!objective.ownerId && String(objective.ownerId) === String(who.employeeId);
  return { canManage, canCheckIn: canManage || (!who.viewOnly && isOwner) };
};

/// Past months are history: only full access may still add to one (to put right something missed). Heads plan this month and ahead.
export const mayAddToMonth = (who, month, currentMonth) => {
  const earlier = month.year < currentMonth.year || (month.year === currentMonth.year && month.month < currentMonth.month);
  return !earlier || !!who.full;
};
