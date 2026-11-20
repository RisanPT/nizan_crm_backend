// WHO IS ON THE CRM TEAM, AND WHO LEADS IT. Pure — tests/crmAccess.test.js. (Finding the team's logins in
// the database is services/crmTeam.js.)
//
// The CRM (Client Relations) team handles booking requests, the client chat, reviews and complaints, trials
// and re-engagement. Two roles belong to it:
//   crm           a CRM team member
//   crm_manager   the CRM HEAD ("CRM Head" in the app) — assigns the team's work, sees everyone's figures
// A `crm` login marked as department head (User.isDepartmentHead — set when an admin names the head of the
// CRM department) counts as the head too.
//
// Code used to test `role === 'crm'`, which turned the CRM Head away from the team's own screens. Ask
// isCrmRole instead.

import { roleGroupOf } from './userAccess.js';
import { isLeadership } from './leadership.js';

const lc = (v) => String(v ?? '').trim().toLowerCase();

export const CRM_HEAD_ROLE = 'crm_manager';

/// A CRM team member or the CRM Head.
export const isCrmRole = (user) => roleGroupOf(user?.role) === 'crm';

/// The CRM Head: the crm_manager role, or a CRM login marked as the department's head.
export const isCrmHead = (user) => lc(user?.role) === CRM_HEAD_ROLE || (isCrmRole(user) && user?.isDepartmentHead === true);

/// What [user] is to the CRM screens:
///   admin       admin / manager — everything, like the head
///   head        the CRM Head — the whole team, assigns work
///   member      a CRM team member — their own work and figures
///   leadership  CEO / Executive Director — reads everything, changes nothing (middleware/ceoGuard.js)
///   none        no CRM access
export const crmViewerOf = (user) => {
  const role = lc(user?.role);
  if (role === 'admin' || role === 'manager') return 'admin';
  if (isLeadership(user)) return 'leadership';
  if (isCrmHead(user)) return 'head';
  if (isCrmRole(user)) return 'member';
  return 'none';
};

/// May [viewer] see the whole team (every member's work and figures)?
export const seesWholeCrmTeam = (viewer) => viewer === 'admin' || viewer === 'head' || viewer === 'leadership';

/// May [viewer] hand work to someone (or take it from them)? Leadership reads only.
export const canAssignCrmWork = (viewer) => viewer === 'admin' || viewer === 'head';
