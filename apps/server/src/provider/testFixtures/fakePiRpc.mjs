/**
 * Model-free stand-in for `pi --mode rpc`.
 *
 * Implements only the parts of the JSONL protocol that `PiRpcTransport` relies
 * on: strict LF framing, `id`-correlated responses, streamed non-response
 * events, and process exit. Every behavior is driven by the command it receives
 * so a single script covers correlation, ordering, timeouts, and shutdown.
 * `get_commands` is scripted through `FAKE_PI_COMMANDS` /
 * `FAKE_PI_GET_COMMANDS` so provider probes can be driven without a model.
 *
 * Run as: node fakePiRpc.mjs
 */

let buffer = "";

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const respond = (id, command, data) => {
  write({
    type: "response",
    id,
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
};

const handle = (command) => {
  const id = command.id;
  switch (command.type) {
    case "ping":
      respond(id, "ping", { pong: command.value, pid: process.pid });
      return;
    case "delay":
      setTimeout(() => respond(id, "delay", { pong: command.value }), Number(command.ms));
      return;
    case "fail":
      write({
        type: "response",
        id,
        command: "fail",
        success: false,
        error: command.detail ?? "boom",
      });
      return;
    case "silent":
      // Deliberately never answers; the client must time out.
      return;
    case "get_commands": {
      // `ok` echoes FAKE_PI_COMMANDS, `error` returns a failed response, and
      // `silent` never answers so the client has to time out.
      const mode = process.env.FAKE_PI_GET_COMMANDS ?? "ok";
      if (mode === "silent") return;
      if (mode === "error") {
        write({
          type: "response",
          id,
          command: "get_commands",
          success: false,
          error: "command listing unavailable",
        });
        return;
      }
      respond(id, "get_commands", JSON.parse(process.env.FAKE_PI_COMMANDS ?? '{"commands":[]}'));
      return;
    }
    case "emit":
      for (let index = 0; index < Number(command.count); index += 1) {
        write({ type: "test_event", index });
      }
      respond(id, "emit", { emitted: Number(command.count) });
      return;
    case "u2028":
      // U+2028/U+2029 are valid inside JSON strings. A reader that treats them
      // as record separators would split this into three bogus records.
      write({ type: "test_event", text: "a\u2028b\u2029c", line: "1\u20282" });
      respond(id, "u2028", { length: "a\u2028b\u2029c".length });
      return;
    case "garbage":
      process.stdout.write("not json at all\n");
      write({ type: "test_event", after: true });
      respond(id, "garbage", { ok: true });
      return;
    case "exit":
      write({ type: "test_event", exiting: true });
      process.exit(Number(command.code));
      return;
    case "notify":
      // Fire-and-forget commands produce no response record.
      return;
    default:
      write({
        type: "response",
        id,
        command: command.type,
        success: false,
        error: `unknown command: ${command.type}`,
      });
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (line.length === 0) {
      continue;
    }
    handle(JSON.parse(line));
  }
});
