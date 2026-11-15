import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { executeRun } from "./run.ts";
import { sleep } from "./pacing.ts";
import { startWda } from "./wda.ts";

// Host agent for the Instagram connector. Usage:
//   node hosts/instagram/index.ts pair --url <convex url> --code <code> --udid <udid>
//   node hosts/instagram/index.ts once     # claim and run one due run
//   node hosts/instagram/index.ts daemon   # poll for due runs every ~minute

const CONFIG = join(homedir(), ".fomovoider", "instagram-agent.json");
const WDA_ROOT = join(homedir(), ".appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent");

type Config = { url: string; token: string; udid: string; wdaProject: string; derivedData: string };

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function loadConfig(): Config {
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

async function pair() {
  const url = arg("url");
  const code = arg("code");
  const udid = arg("udid");
  if (!url || !code || !udid) throw new Error("pair needs --url, --code and --udid");
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const convex = new ConvexHttpClient(url);
  const { deviceId } = await convex.mutation(api.instagram.agent.redeemPairing, { code, tokenHash });
  const config: Config = {
    url,
    token,
    udid,
    wdaProject: arg("wda-project") ?? join(WDA_ROOT, "WebDriverAgent.xcodeproj"),
    derivedData: arg("derived-data") ?? join(homedir(), ".fomovoider", "wda-derived-data"),
  };
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
  log(`paired device ${deviceId}; config at ${CONFIG}`);
}

// One Instagram account, several automated surfaces on this Mac: only one may
// touch Instagram at a time, with a 5 minute gap between them. The lock holds
// "<owner> <pid>"; the .last file holds "<owner> <ISO end time>".
const LOCK = join(homedir(), ".capy", "work", "ig-account.lock");
const LAST = `${LOCK.replace(/\.lock$/, "")}.last`;
const OWNER = process.env.IG_LOCK_OWNER ?? "FOMO-17";
const GAP_MS = 5 * 60_000;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockBlocker(): string | undefined {
  if (existsSync(LOCK)) {
    const [owner, pid] = readFileSync(LOCK, "utf8").trim().split(/\s+/);
    if (Number(pid) && alive(Number(pid))) return `${owner} holds the lock (pid ${pid})`;
  }
  if (existsSync(LAST)) {
    const [owner, at] = readFileSync(LAST, "utf8").trim().split(/\s+/);
    const since = Date.now() - Date.parse(at);
    if (owner !== OWNER && since < GAP_MS) return `${owner} was active ${Math.round(since / 1000)} s ago`;
  }
  return undefined;
}

function releaseLock() {
  rmSync(LOCK, { force: true });
  writeFileSync(LAST, `${OWNER} ${new Date().toISOString()}\n`);
}

async function once(config: Config) {
  const blocker = lockBlocker();
  if (blocker) return log(`waiting: ${blocker}`);
  const convex = new ConvexHttpClient(config.url);
  const claimed = await convex.mutation(api.instagram.agent.claimRun, { token: config.token });
  if (claimed.kind === "paused") return log(`paused until ${new Date(claimed.until).toISOString()}: ${claimed.reason}`);
  if (claimed.kind === "idle") return log("no run due");
  log(`run ${claimed.runId} (${claimed.trigger})`);
  writeFileSync(LOCK, `${OWNER} ${process.pid}\n`);
  try {
    await drive(config, convex, claimed);
  } finally {
    releaseLock();
  }
}

async function drive(
  config: Config,
  convex: ConvexHttpClient,
  claimed: { runId: Id<"instagram_runs">; budget: { maxMs: number; maxPosts: number; maxStoryFrames: number }; knownIds: string[] },
) {
  let wda;
  try {
    wda = await startWda({ udid: config.udid, project: config.wdaProject, derivedData: config.derivedData });
  } catch (err) {
    await convex.mutation(api.instagram.agent.finishRun, {
      token: config.token,
      runId: claimed.runId,
      stats: { posts: 0, storyFrames: 0, durationMs: 0 },
      error: (err as Error).message,
    });
    throw err;
  }
  const { base, child } = wda;
  try {
    const stats = await executeRun({ wdaBase: base, convex, token: config.token, run: claimed, log });
    log(`done: ${JSON.stringify(stats)}`);
  } finally {
    child?.kill();
  }
}

const command = process.argv[2];
if (command === "pair") await pair();
else if (command === "once") await once(loadConfig());
else if (command === "daemon") {
  const config = loadConfig();
  for (;;) {
    await once(config).catch((err) => log(`error: ${err.message}`));
    await sleep(45_000 + Math.random() * 30_000);
  }
} else {
  console.log("usage: node hosts/instagram/index.ts pair|once|daemon");
  process.exit(1);
}
