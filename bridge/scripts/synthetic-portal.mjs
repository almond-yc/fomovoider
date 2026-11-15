// Plays the WhatsApp bridge without WhatsApp: creates a portal room the way
// mautrix-whatsapp does (bridge bot, m.bridge state, a ghost user), invites
// the adapter's user for ACCOUNT_ID, and has the ghost send messages, so the
// adapter -> Convex ingest path can be checked without a phone.
//
//   docker run --rm --network fomovoider-bridge_default --env-file .env \
//     -e ACCOUNT_ID=<connectedAccounts id> -v "$PWD/scripts:/s:ro" \
//     node:24-alpine node /s/synthetic-portal.mjs
const hs = process.env.HOMESERVER_URL ?? "http://synapse:8008";
const token = process.env.WA_AS_TOKEN;
const accountId = process.env.ACCOUNT_ID;
if (!token || !accountId) throw new Error("WA_AS_TOKEN and ACCOUNT_ID are required");

const server = "bridge.local";
const bot = `@whatsappbot:${server}`;
const ghostLocal = "whatsapp_15550000002";
const ghost = `@${ghostLocal}:${server}`;
const owner = `@fv_${accountId}:${server}`;

async function call(method, path, body, { as, ts } = {}) {
  const url = new URL(`${hs}/_matrix/client/v3${path}`);
  if (as) url.searchParams.set("user_id", as);
  if (ts) url.searchParams.set("ts", String(ts));
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok && json.errcode !== "M_USER_IN_USE") throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

await call("POST", "/register", { type: "m.login.application_service", username: ghostLocal, inhibit_login: true });
await call("PUT", `/profile/${encodeURIComponent(ghost)}/displayname`, { displayname: "Synthetic Alice" }, { as: ghost });

const { room_id: roomId } = await call("POST", "/createRoom", {
  preset: "private_chat",
  name: "Synthetic Alice",
  invite: [ghost, owner],
  initial_state: [
    {
      type: "m.bridge",
      state_key: "net.maunium.whatsapp://whatsapp/15550000002@s.whatsapp.net",
      content: {
        bridgebot: bot,
        protocol: { id: "whatsapp", displayname: "WhatsApp" },
        channel: { id: "15550000002@s.whatsapp.net", displayname: "Synthetic Alice" },
        "com.beeper.room_type": "dm",
      },
    },
  ],
});
await call("POST", `/join/${encodeURIComponent(roomId)}`, {}, { as: ghost });
console.log("portal", roomId);

const send = (content, ts) =>
  call("PUT", `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${crypto.randomUUID()}`, content, { as: ghost, ts });

// Backfill-style history (timestamps in the past), then a live message, an
// edit of it, and a photo with a caption.
const hour = 3_600_000;
await send({ msgtype: "m.text", body: "synthetic history 1" }, Date.now() - 3 * hour);
await send({ msgtype: "m.text", body: "synthetic history 2" }, Date.now() - 2 * hour);
const live = await send({ msgtype: "m.text", body: "synthetic live mesage" });
await send({
  msgtype: "m.text",
  body: "* synthetic live message",
  "m.new_content": { msgtype: "m.text", body: "synthetic live message" },
  "m.relates_to": { rel_type: "m.replace", event_id: live.event_id },
});
await send({ msgtype: "m.image", body: "look at this", filename: "photo.jpg", url: "mxc://bridge.local/none" });
console.log("sent 5 events");
