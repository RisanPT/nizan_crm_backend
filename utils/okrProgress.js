// An objective's progress, derived from its key results.
//
// Before this, the objective's progress was a number somebody typed (a slider), so
// an objective could say 100% with every key result at 10%. Now, when it has key
// results, progress IS their average attainment; with none it stays the manual
// figure.
//
// Pure — tests/okrProgress.test.js.

const clamp = (n) => Math.min(100, Math.max(0, n));

/// 0–100 for one key result: done = 100, else current ÷ target.
export const krAttainment = (kr) => {
  if (kr?.completed) return 100;
  const target = Number(kr?.targetValue);
  const current = Number(kr?.currentValue);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(current)) return 0;
  return clamp((current / target) * 100);
};

/// The objective's progress: the key results' average (rounded), or [manual] when
/// there are none.
export const objectiveProgress = (keyResults, manual = 0) => {
  if (!Array.isArray(keyResults) || keyResults.length === 0) return clamp(Math.round(Number(manual) || 0));
  return Math.round(keyResults.reduce((s, kr) => s + krAttainment(kr), 0) / keyResults.length);
};
