import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pi workflow runs were stored as a coordinator row keyed by `kind` plus one row per member.
// The contract reads a run as a single row whose `workflow` carries `agents`, so those rows no
// longer decode and startup reads every thread's projection. Drop them from the events first, or
// a rebuild replays them back in.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM orchestration_events
    WHERE event_type = 'subagent.updated'
      AND json_valid(payload_json)
      AND json_type(payload_json, '$.workflow.kind') IS NOT NULL
      AND json_type(payload_json, '$.workflow.agents') IS NULL
  `;

  yield* sql`
    DELETE FROM orchestration_v2_projection_subagents
    WHERE json_valid(payload_json)
      AND json_type(payload_json, '$.workflow.kind') IS NOT NULL
      AND json_type(payload_json, '$.workflow.agents') IS NULL
  `;
});
