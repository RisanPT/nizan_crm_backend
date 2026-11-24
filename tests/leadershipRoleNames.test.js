// Pure unit tests: node --test tests/leadershipRoleNames.test.js
// A role list that says 'ceo' and nothing else silently leaves the Executive Director out. Roles for "the leaders" must come from
// utils/leadership.js (LEADERSHIP_ROLES / isLeadership). This test lists every file that may still name 'ceo' on its own — each one
// for a reason that is NOT a role list — so a new one shows up here and has to be thought about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const walk = (dir) =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const rel = `${dir}${f}`;
    return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : rel.endsWith('.js') ? [rel] : [];
  });

// file → how many times the literal 'ceo' may appear, and why
const ALLOWED = {
  'utils/leadership.js': [1, 'the one list: LEADERSHIP_ROLES'],
  'utils/ceoAccess.js': [1, 'CEO_ROLE, the exported name kept for old imports'],
  'controllers/roleController.js': [2, 'the seeded CEO role (key: ceo, and its entry in the leadership permission list)'],
  'models/Role.js': [1, 'the permission KEY called ceo (the CEO home), not a role'],
  'controllers/ceoDecisionController.js': [1, 'the permission KEY called ceo'],
  'controllers/employeeController.js': [1, 'org-tree: a designation text containing "ceo" is level 5'],
  'controllers/recruitmentController.js': [4, 'the job-role hierarchy seed (an org-chart node called ceo)'],
};

test('no controller, util, service or route names the CEO on its own in a role list', () => {
  const found = {};
  for (const dir of ['controllers/', 'utils/', 'services/', 'middleware/', 'routes/', 'models/']) {
    for (const file of walk(dir)) {
      const n = (readFileSync(new URL(file, root), 'utf8').match(/'ceo'/g) || []).length;
      if (n) found[file] = n;
    }
  }
  const unexpected = Object.entries(found).filter(([file, n]) => !ALLOWED[file] || n !== ALLOWED[file][0]).map(([file, n]) => `${file} ×${n}`);
  assert.deepEqual(unexpected, [], `'ceo' appears where it did not before — if it is a role list, use LEADERSHIP_ROLES / isLeadership from utils/leadership.js; otherwise add the file to ALLOWED here with the reason`);
  for (const file of Object.keys(ALLOWED)) assert.ok(found[file], `${file} no longer names 'ceo' — remove it from ALLOWED`);
});

test('the role lists that used to say \'ceo\' now read the leadership list', () => {
  const mustUse = [
    'controllers/accountingController.js', 'controllers/assetController.js', 'controllers/cashTransactionController.js', 'controllers/dashboardController.js',
    'controllers/deptReportController.js', 'controllers/depreciationController.js', 'controllers/monthEndController.js', 'controllers/salesReportController.js',
    'controllers/taxFilingController.js', 'controllers/workProfitController.js', 'controllers/marketingInsightsController.js', 'controllers/marketingEodController.js',
    'controllers/performanceController.js', 'controllers/ceoController.js', 'controllers/ceoDecisionController.js', 'controllers/monthlyObjectiveController.js',
    'controllers/notificationController.js', 'utils/departmentScope.js', 'utils/projectAccess.js', 'utils/geoScope.js', 'utils/userAccess.js',
  ];
  for (const file of mustUse) {
    const src = readFileSync(new URL(file, root), 'utf8');
    assert.ok(/LEADERSHIP_ROLES|isLeadership|isLeadershipRole/.test(src), `${file} does not use the leadership list`);
  }
});
