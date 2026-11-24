// Pure unit tests (no database): node --test tests/projectPhases.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { PHASE_SETS, ALL_PROJECT_PHASES, phaseSetFor, phasesFor, fitPhase } from '../utils/projectPhases.js';
import Project from '../models/Project.js';

test('IT keeps the software phases; Marketing gets campaign phases; every other department the business ones', () => {
  assert.deepEqual(phasesFor('IT'), ['discovery', 'design', 'development', 'testing', 'deployment', 'maintenance']);
  assert.deepEqual(phasesFor('Marketing'), ['research', 'planning', 'production', 'launch', 'review']);
  for (const d of ['Accounts', 'Finance', 'HR', 'Sales', 'CRM', 'Operations', 'Artist', 'Fleet', 'Management', 'Academy', '', null]) {
    assert.deepEqual(phasesFor(d), ['initiation', 'planning', 'execution', 'review', 'closure'], String(d));
  }
});

test('the department is read by its name, any case, with a few common spellings', () => {
  assert.equal(phaseSetFor('it'), 'software');
  assert.equal(phaseSetFor('IT Support'), 'software');
  assert.equal(phaseSetFor('Technology'), 'software');
  assert.equal(phaseSetFor('Digital Marketing'), 'campaign');
  assert.equal(phaseSetFor('Brand & Media'), 'campaign');
  assert.equal(phaseSetFor('Audit'), 'standard', '"it" inside a word is not IT');
  assert.equal(phaseSetFor('Fleet'), 'standard');
});

test('a phase of the department is kept', () => {
  assert.equal(fitPhase('testing', 'IT'), 'testing');
  assert.equal(fitPhase('Launch', 'Marketing'), 'launch');
  assert.equal(fitPhase('closure', 'Accounts'), 'closure');
});

test('another department\'s phase becomes the equivalent step', () => {
  // the IT phases every project had before (Discovery was the default) → a business project
  assert.deepEqual(PHASE_SETS.software.map((p) => fitPhase(p, 'Accounts')), ['initiation', 'planning', 'execution', 'review', 'closure', 'closure']);
  // → a campaign
  assert.deepEqual(PHASE_SETS.software.map((p) => fitPhase(p, 'Marketing')), ['research', 'planning', 'production', 'launch', 'review', 'review']);
  // a business project moved to IT
  assert.deepEqual(PHASE_SETS.standard.map((p) => fitPhase(p, 'IT')), ['discovery', 'design', 'development', 'testing', 'deployment']);
});

test('nothing given or an unknown phase → the first step', () => {
  assert.equal(fitPhase('', 'Accounts'), 'initiation');
  assert.equal(fitPhase(undefined, 'IT'), 'discovery');
  assert.equal(fitPhase('whatever', 'Marketing'), 'research');
});

test('every phase is allowed by the model', () => {
  assert.deepEqual([...Project.schema.path('phase').enumValues].sort(), [...ALL_PROJECT_PHASES].sort());
  assert.equal(new Set(ALL_PROJECT_PHASES).size, 14);
});

const base = () => ({ name: 'P', targetDepartment: 'Accounts', managerId: new mongoose.Types.ObjectId() });

test('a new project takes its department\'s first step when no phase is sent, or the equivalent of another department\'s', async () => {
  const a = new Project(base());
  await a.validate().catch(() => {});
  assert.equal(a.phase, 'initiation');
  const b = new Project({ ...base(), phase: 'development' });
  await b.validate().catch(() => {});
  assert.equal(b.phase, 'execution');
  const c = new Project({ ...base(), targetDepartment: 'IT' });
  await c.validate().catch(() => {});
  assert.equal(c.phase, 'discovery');
});

test('moving a project to another department moves its phase to the equivalent step; an untouched project keeps its old phase', async () => {
  // a project saved before departments had their own phases
  const old = Project.hydrate({ _id: new mongoose.Types.ObjectId(), ...base(), phase: 'testing' });
  old.set({ priority: 'high' });
  await old.validate().catch(() => {});
  assert.equal(old.phase, 'testing', 'nothing about its phase or department changed');
  old.set({ targetDepartment: 'Marketing' });
  await old.validate().catch(() => {});
  assert.equal(old.phase, 'launch');
});

test('an unknown phase is still refused', async () => {
  const p = new Project({ ...base(), phase: 'party' });
  const err = await p.validate().then(() => null, (e) => e);
  assert.ok(err?.errors?.phase, 'the enum refuses it');
});
