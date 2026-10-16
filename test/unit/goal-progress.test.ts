import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  computeAllProgress,
  keyResultProgress,
  MAX_GOAL_DEPTH,
  parentProblem,
  roundProgress,
  type GoalNode,
} from '../../src/lib/goal-progress.js';
import { currentPeriods, mondayOf, sortPeriods, zonedDate } from '../../src/lib/time.js';

describe('keyResultProgress', () => {
  it('measures increasing targets, clamped to 0–100', () => {
    expect(keyResultProgress(0, 200, 50)).toBe(25);
    expect(keyResultProgress(10, 20, 15)).toBe(50);
    expect(keyResultProgress(0, 100, 150)).toBe(100);
    expect(keyResultProgress(0, 100, -20)).toBe(0);
  });

  it('measures decreasing targets (start > target)', () => {
    expect(keyResultProgress(2.5, 0.5, 1.2)).toBeCloseTo(65);
    expect(keyResultProgress(100, 40, 100)).toBe(0);
    expect(keyResultProgress(100, 40, 40)).toBe(100);
    expect(keyResultProgress(100, 40, 10)).toBe(100); // overshoot
    expect(keyResultProgress(100, 40, 130)).toBe(0); // got worse
  });

  it('target == start: 100 once current reaches the target, else 0', () => {
    expect(keyResultProgress(5, 5, 5)).toBe(100);
    expect(keyResultProgress(5, 5, 6)).toBe(100);
    expect(keyResultProgress(5, 5, 4.99)).toBe(0);
  });

  it('rounds to 1 decimal for output', () => {
    expect(roundProgress(keyResultProgress(0, 3, 1))).toBe(33.3);
    expect(roundProgress(66.66)).toBe(66.7);
  });
});

const node = (id: string, parentId: string | null, src: GoalNode['progressSource'], extra: Partial<GoalNode> = {}): GoalNode => ({
  id,
  parentId,
  progressSource: src,
  manualProgress: 0,
  weight: 1,
  ...extra,
});

describe('computeAllProgress', () => {
  it('KEY_RESULTS: mean of KR progress, 0 without KRs', () => {
    const graph = buildGraph({
      goals: [node('g', null, 'KEY_RESULTS'), node('empty', null, 'KEY_RESULTS')],
      keyResults: [
        { goalId: 'g', startValue: 0, targetValue: 100, currentValue: 50 },
        { goalId: 'g', startValue: 10, targetValue: 0, currentValue: 0 }, // decreasing, done
        { goalId: 'g', startValue: 3, targetValue: 3, currentValue: 1 }, // flat, not reached
      ],
      links: [],
      projectTasks: new Map(),
    });
    const p = computeAllProgress(graph);
    expect(p.get('g')).toBeCloseTo(50);
    expect(p.get('empty')).toBe(0);
  });

  it('SUB_GOALS: weight-averaged direct children, recursively; 0 without children', () => {
    const graph = buildGraph({
      goals: [
        node('company', null, 'SUB_GOALS'),
        node('teamA', 'company', 'SUB_GOALS', { weight: 3 }),
        node('teamB', 'company', 'MANUAL', { manualProgress: 20, weight: 1 }),
        node('a1', 'teamA', 'MANUAL', { manualProgress: 100 }),
        node('a2', 'teamA', 'MANUAL', { manualProgress: 40 }),
        node('leaf', null, 'SUB_GOALS'),
      ],
      keyResults: [],
      links: [],
      projectTasks: new Map(),
    });
    const p = computeAllProgress(graph);
    expect(p.get('teamA')).toBe(70);
    expect(p.get('company')).toBe((3 * 70 + 1 * 20) / 4); // 57.5
    expect(p.get('leaf')).toBe(0);
  });

  it('PROJECTS: completed ÷ total over linked projects (deduplicated); 0 without tasks', () => {
    const graph = buildGraph({
      goals: [node('g', null, 'PROJECTS'), node('none', null, 'PROJECTS')],
      keyResults: [],
      links: [
        { goalId: 'g', projectId: 'p1' },
        { goalId: 'g', projectId: 'p2' },
        { goalId: 'none', projectId: 'empty' },
      ],
      projectTasks: new Map([
        ['p1', { total: 8, completed: 2 }],
        ['p2', { total: 2, completed: 2 }],
      ]),
    });
    const p = computeAllProgress(graph);
    expect(p.get('g')).toBe(40);
    expect(p.get('none')).toBe(0);
  });

  it('survives a cycle in stored data without recursing forever', () => {
    const graph = buildGraph({
      goals: [node('a', 'b', 'SUB_GOALS'), node('b', 'a', 'SUB_GOALS')],
      keyResults: [],
      links: [],
      projectTasks: new Map(),
    });
    const p = computeAllProgress(graph);
    expect(p.get('a')).toBe(0);
    expect(p.get('b')).toBe(0);
  });
});

describe('parentProblem (cycle and depth checks)', () => {
  // r → a → b → c (depth 4), plus a separate chain x → y.
  const rows: [string, string | null][] = [
    ['r', null],
    ['a', 'r'],
    ['b', 'a'],
    ['c', 'b'],
    ['x', null],
    ['y', 'x'],
  ];
  const parents = new Map(rows);
  const children = new Map<string, string[]>();
  for (const [id, parent] of rows) if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);

  it('rejects self-parenting and cycles', () => {
    expect(parentProblem(parents, children, 'a', 'a')).toMatch(/own parent/);
    expect(parentProblem(parents, children, 'a', 'c')).toMatch(/ancestor/);
    expect(parentProblem(parents, children, 'r', 'b')).toMatch(/ancestor/);
    expect(parentProblem(parents, children, 'a', 'missing')).toMatch(/not found/);
    expect(parentProblem(parents, children, 'c', 'a')).toBeNull();
  });

  it(`allows ${MAX_GOAL_DEPTH} levels and rejects ${MAX_GOAL_DEPTH + 1}, counting the moved subtree`, () => {
    // New goal under c → depth 5 (ok); a chain of 6 from scratch is ok, 7 is not.
    expect(parentProblem(parents, children, undefined, 'c')).toBeNull();
    const deep = new Map(parents).set('d', 'c').set('e', 'd'); // e at depth 6
    expect(parentProblem(deep, children, undefined, 'd')).toBeNull(); // 6
    expect(parentProblem(deep, children, undefined, 'e')).toMatch(/at most 6/); // 7

    // Moving x (height 2) under c (depth 4) → 6 levels: ok. Under a 5-deep goal → 7: rejected.
    expect(parentProblem(parents, children, 'x', 'c')).toBeNull();
    expect(parentProblem(deep, children, 'x', 'd')).toMatch(/at most 6/);
  });
});

describe('time helpers', () => {
  it('uses the configured zone for today and current periods', () => {
    // 2026-12-31 18:00 UTC is already 2027-01-01 01:00 in Jakarta (UTC+7).
    const at = new Date('2026-12-31T18:00:00Z');
    expect(zonedDate('UTC', at)).toBe('2026-12-31');
    expect(zonedDate('Asia/Jakarta', at)).toBe('2027-01-01');
    expect(currentPeriods('UTC', at)).toEqual(['2026', '2026-H2', '2026-Q4']);
    expect(currentPeriods('Asia/Jakarta', at)).toEqual(['2027', '2027-H1', '2027-Q1']);
  });

  it('finds Monday-start weeks', () => {
    expect(mondayOf('2026-10-15')).toBe('2026-10-12'); // Thursday
    expect(mondayOf('2026-10-12')).toBe('2026-10-12'); // Monday
    expect(mondayOf('2026-10-18')).toBe('2026-10-12'); // Sunday
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });

  it('sorts periods newest year first, then Y, H1, Q1, Q2, H2, Q3, Q4', () => {
    expect(sortPeriods(['2026-Q2', '2025', '2026-H2', '2026', '2026-Q4', '2026-H1', '2026-Q1', '2026-Q3', '2026-Q1'])).toEqual([
      '2026',
      '2026-H1',
      '2026-Q1',
      '2026-Q2',
      '2026-H2',
      '2026-Q3',
      '2026-Q4',
      '2025',
    ]);
  });
});
