/**
 * Subagents left active by a run that already ended.
 *
 * A provider-native subagent advances only when its provider emits an event for
 * that native task. When a turn ends without one — killed process, dropped
 * native payload, cancelled run — the row keeps `running` forever: the agent
 * panel shows a live agent on a finished workflow, its card never reaches
 * `1/1 settled`, and the elapsed counter keeps counting because `completedAt`
 * stays null.
 *
 * Measured on a real thread: 21 such rows, every one with its parent node and
 * parent run already terminal, the oldest 8 days old. A terminal run cannot
 * emit more events for its subagents, so the read path settles them.
 */
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

/** Run status → the subagent status that run leaves behind, if it ended. */
const SETTLED_STATUS_BY_RUN_STATUS = new Map<string, OrchestrationV2Subagent["status"]>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["interrupted", "interrupted"],
  // Discarded work stopped, but nobody cancelled it.
  ["rolled_back", "interrupted"],
]);

export interface SettledSubagentRunRow {
  readonly subagent_id: string;
  readonly run_status: string;
  readonly completed_at: string | null;
}

/**
 * Applies the rows resolved by the caller's store query. Returns the same array
 * when nothing is stale so callers can keep referential equality.
 */
export function settleSubagentsOfEndedRuns(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  endedRuns: ReadonlyArray<SettledSubagentRunRow>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (endedRuns.length === 0) return subagents;
  const settledById = new Map(endedRuns.map((row) => [row.subagent_id, row] as const));
  let changed = false;
  const settled = subagents.map((subagent) => {
    const row = settledById.get(subagent.id);
    const status = row === undefined ? undefined : SETTLED_STATUS_BY_RUN_STATUS.get(row.run_status);
    if (row === undefined || status === undefined) return subagent;
    changed = true;
    return {
      ...subagent,
      status,
      completedAt:
        subagent.completedAt ??
        (row.completed_at === null ? subagent.updatedAt : DateTime.makeUnsafe(row.completed_at)),
    };
  });
  return changed ? settled : subagents;
}
