import type { BridgeConfig } from "./bridges.js";

export interface Config {
  port: number;
  homeserverUrl: string;
  serverName: string;
  asToken: string;
  hsToken: string;
  bridgeSecret: string;
  convexSiteUrl: string;
  stateFile: string;
  bridges: BridgeConfig[];
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bridges: BridgeConfig[] = [];
  if (env.WHATSAPP_URL) {
    bridges.push({
      platform: "whatsapp",
      url: env.WHATSAPP_URL,
      asToken: required(env, "WHATSAPP_AS_TOKEN"),
      provisioningSecret: required(env, "WHATSAPP_PROVISIONING_SECRET"),
      ghostPrefix: "whatsapp_",
      protocols: ["whatsapp"],
    });
  }
  if (env.MESSENGER_URL) {
    bridges.push({
      platform: "messenger",
      url: env.MESSENGER_URL,
      asToken: required(env, "MESSENGER_AS_TOKEN"),
      provisioningSecret: required(env, "MESSENGER_PROVISIONING_SECRET"),
      ghostPrefix: "facebook_",
      protocols: ["facebook", "messenger"],
    });
  }
  return {
    port: Number(env.PORT ?? 8080),
    homeserverUrl: required(env, "HOMESERVER_URL"),
    serverName: required(env, "SERVER_NAME"),
    asToken: required(env, "AS_TOKEN"),
    hsToken: required(env, "HS_TOKEN"),
    bridgeSecret: required(env, "BRIDGE_SECRET"),
    convexSiteUrl: required(env, "CONVEX_SITE_URL"),
    stateFile: env.STATE_FILE ?? "state.json",
    bridges,
  };
}
