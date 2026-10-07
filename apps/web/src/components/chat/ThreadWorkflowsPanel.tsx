/**
 * Workflow runs for the thread details panel: one card per Pi workflow run,
 * listing its phases and the agents that ran in each. The subagent projection
 * is grouped through the shared client-runtime helper, so web and mobile draw
 * one view of a run. Threads that never ran a workflow render nothing.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isTerminalSubagentStatus,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveAgentPanelModel,
  type WorkflowAgentGroup,
  type WorkflowPhaseGroup,
} from "@t3tools/client-runtime/state/workflow-groups";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadProjection } from "../../state/entities";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { subagentStatusVisual } from "./V2LifecycleRow";

function StatusDot({ status }: { readonly status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", subagentStatusVisual(status).dotClass)}
    />
  );
}

/** One member row: status, name, state word, elapsed. Non-interactive. */
function WorkflowMemberRow({ member }: { readonly member: RuntimeSubagent }) {
  const visual = subagentStatusVisual(member.status);
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5" data-workflow-member>
      <StatusDot status={member.status} />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{member.title}</span>
      <span
        className={cn(
          "shrink-0 text-2xs",
          member.status === "failed" ? "text-destructive" : "text-muted-foreground/80",
        )}
      >
        {visual.label}
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        <AgentElapsed agent={member} />
      </span>
    </div>
  );
}

/** The phase's second line: what the rail would say at a glance. */
function phaseSummary(phase: WorkflowPhaseGroup): string {
  switch (phase.state) {
    case "done":
      return `${phase.settledCount} done`;
    case "running":
      return `${phase.activeCount} active · ${phase.settledCount} done`;
    case "skipped":
      return "not reached";
    case "pending":
      return "pending";
  }
}

/**
 * One phase row. A phase with no members says why: the run ended before it
 * started ("Not reached"), or the run is still to get there ("Waiting to
 * start"). The two read differently so a finished run never looks unfinished.
 */
function WorkflowPhaseRow({ phase }: { readonly phase: WorkflowPhaseGroup }) {
  return (
    <div data-workflow-phase={phase.state}>
      <div
        className={cn(
          "flex items-center gap-1.5 px-1.5 pt-2 text-2xs font-medium uppercase tracking-wide",
          phase.state === "done"
            ? "text-success"
            : phase.state === "running"
              ? "text-info"
              : "text-muted-foreground/70",
        )}
      >
        {phase.state === "done" ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
        <span className="min-w-0 truncate">{phase.title}</span>
        <span className="ml-auto shrink-0 font-normal normal-case text-muted-foreground/70">
          {phaseSummary(phase)}
        </span>
      </div>
      {phase.members.length > 0 ? (
        phase.members.map((member) => <WorkflowMemberRow key={member.id} member={member} />)
      ) : (
        <p className="px-1.5 pt-0.5 text-2xs text-muted-foreground/60">
          {phase.state === "skipped" ? "Not reached" : "Waiting to start"}
        </p>
      )}
    </div>
  );
}

/**
 * One workflow run. Open while the run is live so its phases are visible, and
 * collapsed once settled so old runs do not push the rest of the panel away.
 */
function WorkflowCard({ group }: { readonly group: WorkflowAgentGroup }) {
  const [expanded, setExpanded] = useState(() => !isTerminalSubagentStatus(group.workflow.status));
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const failedCount = members.filter((member) => member.status === "failed").length;
  const settledCount = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
  return (
    <section className="rounded-lg border border-border/60 bg-card/30" data-workflow-card>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      >
        <StatusDot status={failedCount > 0 ? "failed" : group.workflow.status} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
          {group.label}
        </span>
        {failedCount > 0 ? (
          <span className="shrink-0 text-2xs text-destructive">{failedCount} failed</span>
        ) : null}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/80">
          {settledCount}/{members.length} settled
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="border-t border-border/50 px-0.5 pb-1">
          {group.phases.map((phase) => (
            <WorkflowPhaseRow key={phase.index} phase={phase} />
          ))}
          {group.unphasedMembers.length > 0 ? (
            <div className="pt-1">
              <div className="px-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
                Unphased
              </div>
              {group.unphasedMembers.map((member) => (
                <WorkflowMemberRow key={member.id} member={member} />
              ))}
            </div>
          ) : null}
          {members.length === 0 ? <WorkflowMemberRow member={group.workflow} /> : null}
        </div>
      ) : null}
    </section>
  );
}

export function ThreadWorkflowsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection =
    useThreadProjection(scopeThreadRef(props.environmentId, props.threadId))?.projection ?? null;
  const model = useMemo(
    () => deriveAgentPanelModel(projectedSubagentsToRuntime(projection?.subagents ?? [])),
    [projection?.subagents],
  );
  if (model.workflows.length === 0) {
    return null;
  }
  return (
    <ThreadDetailsSection
      headingId="thread-details-workflows-heading"
      title={`Workflows · ${model.workflows.length}`}
      data-thread-workflows-panel
    >
      <div className="flex flex-col gap-1.5">
        {model.workflows.map((group) => (
          <WorkflowCard key={group.workflow.id} group={group} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
