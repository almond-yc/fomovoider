import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { handle as xWebhook } from "./x/webhook";

const http = httpRouter();

auth.addHttpRoutes(http);

// X Activity API: CRC checks (GET) and events (POST). See convex/x/README.md.
http.route({ path: "/x/webhook", method: "GET", handler: xWebhook });
http.route({ path: "/x/webhook", method: "POST", handler: xWebhook });

export default http;
