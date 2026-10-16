/**
 * Goal progress (SPEC §10), computed in memory from one batch load, so there are no per-goal
 * queries. Values stay unrounded while rolling up; callers round once per goal for output.
 */
import type { GoalProgressSource } from '@prisma/client';

export const MAX_GOAL_DEPTH = 6;

/** clamp((current − start) / (target − start) × 100, 0, 100). Handles decreasing targets (start > target). */
export function keyResultProgress(start: number, target: number, current: number): number {
  if (target === start) {
    // Nothing to move: done once current reaches the target, in the KR's direction (none here).
    return current >= target ? 100 : 0;
  }
  const raw = ((current - start) / (target - start)) * 100;
  return Math.min(100, Math.max(0, raw));
}

export const roundProgress = (p: number) => Math.round(p * 10) / 10;

export type GoalNode = {
  id: string;
  parentId: string | null;
  progressSource: GoalProgressSource;
  manualProgress: number;
  weight: number;
};
export type KrValues = { startValue: number; targetValue: number; currentValue: number };
export type TaskCounts = { total: number; completed: number };

export type GoalGraph = {
  goals: Map<string, GoalNode>;
  children: Map<string, string[]>;
  keyResults: Map<string, KrValues[]>;
  /** Linked project ids per goal. */
  projects: Map<string, string[]>;
  /** All tasks (incl. subtasks) per project. */
  projectTasks: Map<string, TaskCounts>;
};

export function buildGraph(input: {
  goals: GoalNode[];
  keyResults: (KrValues & { goalId: string })[];
  links: { goalId: string; projectId: string }[];
  projectTasks: Map<string, TaskCounts>;
}): GoalGraph {
  const goals = new Map(input.goals.map((g) => [g.id, g]));
  const children = new Map<string, string[]>();
  for (const g of input.goals) {
    if (g.parentId && goals.has(g.parentId)) push(children, g.parentId, g.id);
  }
  const keyResults = new Map<string, KrValues[]>();
  for (const kr of input.keyResults) push(keyResults, kr.goalId, kr);
  const projects = new Map<string, string[]>();
  for (const l of input.links) push(projects, l.goalId, l.projectId);
  return { goals, children, keyResults, projects, projectTasks: input.projectTasks };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Unrounded progress (0–100) of every goal in the graph. */
export function computeAllProgress(graph: GoalGraph): Map<string, number> {
  const done = new Map<string, number>();
  const visiting = new Set<string>();

  const progressOf = (id: string): number => {
    const cached = done.get(id);
    if (cached !== undefined) return cached;
    const goal = graph.goals.get(id);
    // Unknown goal or a cycle (prevented on write, guarded here anyway): contribute 0.
    if (!goal || visiting.has(id)) return 0;
    visiting.add(id);
    let p = 0;
    switch (goal.progressSource) {
      case 'MANUAL':
        p = goal.manualProgress;
        break;
      case 'KEY_RESULTS': {
        const krs = graph.keyResults.get(id) ?? [];
        p = krs.length
          ? krs.reduce((sum, kr) => sum + keyResultProgress(kr.startValue, kr.targetValue, kr.currentValue), 0) / krs.length
          : 0;
        break;
      }
      case 'SUB_GOALS': {
        const kids = graph.children.get(id) ?? [];
        let weighted = 0;
        let weights = 0;
        for (const kid of kids) {
          const w = graph.goals.get(kid)!.weight;
          weighted += w * progressOf(kid);
          weights += w;
        }
        p = weights ? weighted / weights : 0;
        break;
      }
      case 'PROJECTS': {
        let total = 0;
        let completed = 0;
        for (const pid of new Set(graph.projects.get(id) ?? [])) {
          const c = graph.projectTasks.get(pid);
          if (c) {
            total += c.total;
            completed += c.completed;
          }
        }
        p = total ? (completed / total) * 100 : 0;
        break;
      }
    }
    visiting.delete(id);
    p = Math.min(100, Math.max(0, p));
    done.set(id, p);
    return p;
  };

  for (const id of graph.goals.keys()) progressOf(id);
  return done;
}

// --- hierarchy checks ----------------------------------------------------------

/** Levels from the root down to `id`, inclusive (a root goal is depth 1). */
export function depthOf(parents: Map<string, string | null>, id: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let cur: string | null | undefined = id; cur && !seen.has(cur); cur = parents.get(cur)) {
    seen.add(cur);
    depth += 1;
  }
  return depth;
}

/** Levels in the subtree rooted at `id`, inclusive (a leaf is height 1). */
export function heightOf(children: Map<string, string[]>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let max = 0;
  for (const kid of children.get(id) ?? []) max = Math.max(max, heightOf(children, kid, seen));
  return 1 + max;
}

/**
 * Why `goalId` (undefined = a new goal) can't be placed under `parentId`, or null if it can:
 * self-parenting, cycles, and exceeding MAX_GOAL_DEPTH levels.
 */
export function parentProblem(
  parents: Map<string, string | null>,
  children: Map<string, string[]>,
  goalId: string | undefined,
  parentId: string,
): string | null {
  if (!parents.has(parentId)) return 'Parent goal not found';
  if (goalId && parentId === goalId) return 'A goal cannot be its own parent';
  if (goalId) {
    // A cycle forms if the new parent sits inside the goal's own subtree.
    const seen = new Set<string>();
    for (let cur: string | null | undefined = parentId; cur && !seen.has(cur); cur = parents.get(cur)) {
      if (cur === goalId) return 'This would make the goal its own ancestor';
      seen.add(cur);
    }
  }
  const height = goalId ? heightOf(children, goalId) : 1;
  if (depthOf(parents, parentId) + height > MAX_GOAL_DEPTH) {
    return `Goals can be nested at most ${MAX_GOAL_DEPTH} levels deep`;
  }
  return null;
}
