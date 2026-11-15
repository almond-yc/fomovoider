import { httpAction } from "../_generated/server";
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { bridgeSecret, sameSecret } from "./lib";

// POST /bridge/events: the bridge host's pushes (pairing codes, login state,
// conversations and messages), authenticated with BRIDGE_SECRET.
export const events = httpAction(async (ctx, request) => {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), bridgeSecret())) {
    return new Response("Unauthorized", { status: 401 });
  }
  let event: unknown;
  try {
    event = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  try {
    await ctx.runMutation(internal.bridge.events.apply, { event: event as never });
  } catch (error) {
    return new Response((error as Error).message, { status: 400 });
  }
  return new Response(null, { status: 204 });
});

export function registerBridgeRoutes(http: HttpRouter) {
  http.route({ path: "/bridge/events", method: "POST", handler: events });
}
