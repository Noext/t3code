import { assert, it } from "@effect/vitest";
import { OrchestrationV2SubagentJson } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);

// The two shapes Pi wrote before the contract folded a run into one row carrying `agents`.
const legacyCoordinator = {
  id: "node:workflow",
  threadId: "thread-1",
  runId: null,
  parentNodeId: "node:run:root",
  origin: "provider_native",
  createdBy: "agent",
  driver: "pi",
  providerInstanceId: "pi",
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: { driver: "pi", nativeId: "run-1", strength: "strong" },
  prompt: "Run",
  title: "Run",
  model: null,
  status: "completed",
  result: null,
  workflow: {
    kind: "workflow",
    workflowName: "Run",
    phases: [{ index: 0, title: "Recon" }],
    phaseIndex: null,
    phaseTitle: null,
    agentIndex: null,
    runId: "run-1",
  },
  startedAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const legacyMember = {
  ...legacyCoordinator,
  id: "node:workflow:member",
  parentNodeId: "node:workflow",
  nativeTaskRef: { driver: "pi", nativeId: "run-1:wf:1", strength: "strong" },
  prompt: "step",
  workflow: {
    kind: "workflow_agent",
    workflowName: "Run",
    phases: [],
    phaseIndex: 0,
    phaseTitle: "Recon",
    agentIndex: 0,
    runId: "run-1",
  },
};

const current = {
  ...legacyCoordinator,
  id: "node:current",
  nativeTaskRef: { driver: "claude", nativeId: "run-2", strength: "strong" },
  workflow: {
    name: "Run",
    runHandles: { runId: "run-2" },
    phases: [{ index: 0, title: "Recon" }],
    agents: [{ index: 0, label: "step", state: "completed" }],
  },
};

layer("078_DropLegacyPiWorkflowSubagents", (it) => {
  it.effect("drops only the rows and events the merged contract cannot read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });

      const rows: ReadonlyArray<readonly [string, unknown]> = [
        ["node:workflow", legacyCoordinator],
        ["node:workflow:member", legacyMember],
        ["node:current", current],
      ];
      for (const [index, [id, payload]] of rows.entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_subagents (
            subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json
          ) VALUES (
            ${id}, 'thread-1', 'node:run:root', 'pi', 'provider_native', 'completed',
            '2026-09-01T00:00:00.000Z', ${JSON.stringify(payload)}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          ) VALUES (
            ${`event:${id}`}, 'thread', 'thread-1', ${index + 1}, 'subagent.updated',
            '2026-09-01T00:00:00.000Z', 'agent', ${JSON.stringify(payload)}, '{}', 2
          )
        `;
      }
      // An unrelated subagent event must survive: the delete keys on the workflow block alone.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:plain', 'thread', 'thread-1', 99, 'subagent.updated',
          '2026-09-01T00:00:00.000Z', 'agent', '{}', '{}', 2
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 78 });

      const surviving = yield* sql<{ readonly subagent_id: string; readonly payload_json: string }>`
        SELECT subagent_id, payload_json FROM orchestration_v2_projection_subagents ORDER BY 1
      `;
      assert.deepStrictEqual(
        surviving.map((row) => row.subagent_id),
        ["node:current"],
      );
      const events = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events ORDER BY 1
      `;
      assert.deepStrictEqual(
        events.map((row) => row.event_id),
        ["event:node:current", "event:plain"],
      );
      yield* decodeSubagentPayload(surviving[0]!.payload_json);
    }),
  );
});
