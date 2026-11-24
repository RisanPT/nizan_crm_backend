// The phases a company project moves through, by the kind of work its OWNING department does. IT builds software; Marketing runs
// campaigns; every other department (Accounts, Finance, HR, Sales, CRM, Operations, Artist, Fleet, Management, and any added later)
// runs a business project. Mirrored in the app: lib/features/it/domain/project_phases.dart — keep the two in step.

export const PHASE_SETS = {
  software: ['discovery', 'design', 'development', 'testing', 'deployment', 'maintenance'],
  campaign: ['research', 'planning', 'production', 'launch', 'review'],
  standard: ['initiation', 'planning', 'execution', 'review', 'closure'],
};

/** Every phase any project may be in (the model's enum). */
export const ALL_PROJECT_PHASES = [...new Set(Object.values(PHASE_SETS).flat())];

// Where each phase sits on one common path (start → plan → do → check → finish), so a project that changes department — or one
// saved before departments had their own phases — keeps the equivalent step.
const STAGE = {
  discovery: 0, initiation: 0, research: 0,
  design: 1, planning: 1,
  development: 2, execution: 2, production: 2,
  testing: 3, review: 3, launch: 3,
  deployment: 4, maintenance: 4, closure: 4,
};

/** 'software' | 'campaign' | 'standard' for a department's name. */
export function phaseSetFor(department) {
  const d = String(department ?? '').trim().toLowerCase();
  if (/\b(it|tech|technology|software)\b/.test(d)) return 'software';
  if (/market|brand|content|media|social/.test(d)) return 'campaign';
  return 'standard';
}

/** The phases for a project owned by [department], in order. */
export const phasesFor = (department) => PHASE_SETS[phaseSetFor(department)];

/**
 * The phase to keep for a project owned by [department]: [phase] itself when it is one of that department's phases, else the
 * equivalent step in its list (Discovery on an Accounts project → Initiation), else the first. Empty → the first.
 */
export function fitPhase(phase, department) {
  const list = phasesFor(department);
  const p = String(phase ?? '').trim().toLowerCase();
  if (list.includes(p)) return p;
  const stage = STAGE[p];
  if (stage === undefined) return list[0];
  return list.find((x) => STAGE[x] === stage) ?? list.filter((x) => STAGE[x] < stage).at(-1) ?? list[0];
}
