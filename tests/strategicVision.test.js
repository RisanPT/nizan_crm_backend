import test from 'node:test';
import assert from 'node:assert/strict';
import StrategicVision from '../models/StrategicVision.js';

test('StrategicVision schema has valid defaults for 15-year planning', () => {
  const vision = new StrategicVision({});
  assert.equal(vision.startYear, 2026);
  assert.equal(vision.targetYear, 2041);
  assert.equal(vision.horizons.length, 3);

  const [h1, h2, h3] = vision.horizons;
  assert.equal(h1.horizonNumber, 1);
  assert.equal(h1.startYear, 2026);
  assert.equal(h1.endYear, 2028);

  assert.equal(h2.horizonNumber, 2);
  assert.equal(h2.startYear, 2029);
  assert.equal(h2.endYear, 2033);

  assert.equal(h3.horizonNumber, 3);
  assert.equal(h3.startYear, 2034);
  assert.equal(h3.endYear, 2041);

  assert(vision.pillars.length >= 4);
  const pillarIds = vision.pillars.map((p) => p.id);
  assert(pillarIds.includes('expansion'));
  assert(pillarIds.includes('tech'));
  assert(pillarIds.includes('brand'));
  assert(pillarIds.includes('people'));

  assert(vision.milestones.length >= 4);
  for (const m of vision.milestones) {
    assert([1, 2, 3].includes(m.horizonNumber));
    assert(m.targetYear >= 2026 && m.targetYear <= 2041);
    assert(pillarIds.includes(m.pillarId));
  }
});

test('Horizon categorization logic groups projects accurately', () => {
  const mockProjects = [
    { name: 'P1', horizonNumber: 1, progress: 50 },
    { name: 'P2', horizonNumber: 1, progress: 100 },
    { name: 'P3', horizonNumber: 2, progress: 20 },
    { name: 'P4', horizonNumber: 3, progress: 0 },
    { name: 'Legacy Project with no horizon', progress: 40 }, // should default to H1
  ];

  const h1Projects = mockProjects.filter((p) => (p.horizonNumber || 1) === 1);
  const h2Projects = mockProjects.filter((p) => p.horizonNumber === 2);
  const h3Projects = mockProjects.filter((p) => p.horizonNumber === 3);

  assert.equal(h1Projects.length, 3);
  assert.equal(h2Projects.length, 1);
  assert.equal(h3Projects.length, 1);

  const h1AvgProgress = Math.round(h1Projects.reduce((s, p) => s + (p.progress || 0), 0) / h1Projects.length);
  assert.equal(h1AvgProgress, Math.round((50 + 100 + 40) / 3)); // 63%
});

test('StrategicVision supports dynamic multi-year plans (5-year, 10-year, 20-year plans)', () => {
  const custom5Year = new StrategicVision({
    title: 'Vision 2031: 5-Year Acceleration Plan',
    startYear: 2026,
    targetYear: 2031,
    horizons: [
      { horizonNumber: 1, name: 'H1: Foundation', startYear: 2026, endYear: 2028 },
      { horizonNumber: 2, name: 'H2: Scale', startYear: 2029, endYear: 2031 },
    ],
  });
  assert.equal(custom5Year.startYear, 2026);
  assert.equal(custom5Year.targetYear, 2031);
  assert.equal(custom5Year.horizons.length, 2);

  const custom20Year = new StrategicVision({
    title: 'Vision 2046: 20-Year Global Vision',
    startYear: 2026,
    targetYear: 2046,
    horizons: [
      { horizonNumber: 1, name: 'H1', startYear: 2026, endYear: 2028 },
      { horizonNumber: 2, name: 'H2', startYear: 2029, endYear: 2033 },
      { horizonNumber: 3, name: 'H3', startYear: 2034, endYear: 2040 },
      { horizonNumber: 4, name: 'H4', startYear: 2041, endYear: 2046 },
    ],
  });
  assert.equal(custom20Year.horizons.length, 4);
  assert.equal(custom20Year.horizons[3].horizonNumber, 4);
});


