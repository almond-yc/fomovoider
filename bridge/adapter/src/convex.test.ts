import assert from "node:assert/strict";
import { test } from "node:test";
import { ConvexPush } from "./convex.js";

const me = { id: "whatsapp:1" as const, platform: "whatsapp", handle: "1", displayName: "Me" };
const message = {
  id: "whatsapp:$m" as const,
  conversationId: "whatsapp:c" as const,
  sender: me,
  isMine: true,
  sentAt: "2026-11-15T00:00:00.000Z",
  text: "x",
  media: [],
};

function fakeConvex(statuses: number[]) {
  const posted: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)).kind);
    const status = statuses.shift() ?? 204;
    return new Response(status === 204 ? null : "", { status });
  }) as typeof fetch;
  return { posted, push: new ConvexPush("http://convex", "secret", fetchImpl, { flushMs: 1000, retries: 3, backoffMs: 1 }) };
}

test("updates batched before the identity is confirmed are sent after it", async () => {
  const { posted, push } = fakeConvex([]);
  push.sync("acc1", { message });
  await push.send({ accountId: "acc1", deviceId: "d", kind: "connected", me });
  await push.drain();
  assert.deepEqual(posted, ["connected", "sync"]);
});

test("a not-ready account (409) is retried; a bad request is not", async () => {
  const retried = fakeConvex([409, 409]);
  retried.push.sync("acc1", { message });
  await retried.push.drain();
  assert.deepEqual(retried.posted, ["sync", "sync", "sync"]);

  const refused = fakeConvex([400]);
  refused.push.sync("acc1", { message });
  await refused.push.drain();
  assert.deepEqual(refused.posted, ["sync"]);
});
