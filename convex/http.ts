import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { registerBridgeRoutes } from "./bridge/http";

const http = httpRouter();

auth.addHttpRoutes(http);
registerBridgeRoutes(http);

export default http;
