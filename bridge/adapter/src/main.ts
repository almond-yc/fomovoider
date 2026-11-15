import { Adapter } from "./adapter.js";
import { Provisioning } from "./bridges.js";
import { loadConfig } from "./config.js";
import { ConvexPush } from "./convex.js";
import { Matrix } from "./matrix.js";
import { createAdapterServer } from "./server.js";
import { StateFile } from "./state.js";

const config = loadConfig();
const adapter = new Adapter({
  serverName: config.serverName,
  bridges: config.bridges,
  matrix: new Matrix(config.homeserverUrl, config.asToken),
  provisioning: new Map(config.bridges.map((bridge) => [bridge.platform, new Provisioning(bridge)])),
  convex: new ConvexPush(config.convexSiteUrl, config.bridgeSecret),
  state: new StateFile(config.stateFile),
});
const server = createAdapterServer({
  adapter,
  hsToken: config.hsToken,
  bridgeSecret: config.bridgeSecret,
  bridgeTokens: Object.fromEntries(config.bridges.map((bridge) => [bridge.platform, bridge.asToken])),
});
server.listen(config.port, () => {
  console.log(`adapter listening on :${config.port} for ${config.bridges.map((b) => b.platform).join(", ")}`);
});
