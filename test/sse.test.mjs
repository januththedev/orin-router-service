import "./_hooks.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SseParser, SSE_DONE } from "../src/sse.js";
import { StreamSession } from "../src/stream-session.js";

test("SSE parser handles multiline, CRLF, and final data", () => {
  const events = [];
  const parser = new SseParser();
  parser.push(new TextEncoder().encode("data: one\r\ndata: two\r\n\r\ndata: final"), (event) => events.push(event.data));
  parser.end((event) => events.push(event.data));
  assert.deepEqual(events, ["one\ntwo", "final"]);
});
test("stream session commits once and emits one terminal", () => {
  const output = [];
  let commits = 0;
  const session = new StreamSession({ event: (value) => output.push(value), done: () => output.push("<done>") }, () => { commits += 1; });
  session.emit({ hello: "world" });
  session.finish({ done: true });
  session.finish({ ignored: true });
  assert.equal(commits, 1);
  assert.equal(output.filter((value) => value === SSE_DONE).length, 1);
  assert.equal(output.at(-1), "<done>");
});
