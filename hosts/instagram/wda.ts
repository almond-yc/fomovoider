import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Thin client for WebDriverAgent's HTTP API on the iPhone, reached over the
// CoreDevice tunnel that Xcode keeps up while the device is connected.

export type Rect = { x: number; y: number; width: number; height: number };

export function tunnelAddress(udid: string) {
  const out = execFileSync("xcrun", ["devicectl", "device", "info", "details", "--device", udid], {
    encoding: "utf8",
  });
  const match = out.match(/Tunnel IP Address:\s*(\S+)/);
  if (!match) throw new Error("No CoreDevice tunnel to the iPhone; is it connected and unlocked?");
  return match[1];
}

export function wdaBaseUrl(udid: string, port = 8100) {
  const host = tunnelAddress(udid);
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

// Starts the WebDriverAgentRunner XCUITest (built once with build-for-testing)
// and waits until it answers.
export function isLocked(udid: string) {
  const out = execFileSync("xcrun", ["devicectl", "device", "info", "lockState", "--device", udid], {
    encoding: "utf8",
  });
  return /passcodeRequired:\s*true/.test(out);
}

export async function startWda(opts: { udid: string; project: string; derivedData: string }) {
  if (isLocked(opts.udid)) throw new Error("The iPhone is locked; unlock it and keep it awake for the run");
  const base = wdaBaseUrl(opts.udid);
  if (await ping(base)) return { base, child: undefined as ChildProcess | undefined };
  const child = spawn(
    "xcodebuild",
    [
      "test-without-building",
      "-project", opts.project,
      "-scheme", "WebDriverAgentRunner",
      "-destination", `id=${opts.udid}`,
      "-derivedDataPath", opts.derivedData,
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    if (await ping(base)) return { base, child };
    if (child.exitCode !== null) break;
  }
  child.kill();
  throw new Error("WebDriverAgent did not start; check signing and that the phone is unlocked");
}

async function ping(base: string) {
  try {
    const res = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export class Wda {
  private base: string;
  private sid: string;

  private constructor(base: string, sid: string) {
    this.base = base;
    this.sid = sid;
  }

  static async launch(base: string, bundleId: string) {
    const res = await call(base, "POST", "/session", {
      capabilities: { alwaysMatch: { bundleId, shouldWaitForQuiescence: false } },
    });
    const wda = new Wda(base, res.sessionId ?? res.value.sessionId);
    await wda.post("/appium/settings", {
      settings: { snapshotMaxDepth: 62, useFirstMatch: true, animationCoolOffTimeout: 0 },
    });
    return wda;
  }

  private post(path: string, body: unknown) {
    return call(this.base, "POST", `/session/${this.sid}${path}`, body);
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    return (await call(this.base, "GET", `/session/${this.sid}/window/size`)).value;
  }

  async source(): Promise<string> {
    return (await call(this.base, "GET", `/session/${this.sid}/source?format=xml`)).value;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from((await call(this.base, "GET", "/screenshot")).value, "base64");
  }

  // Raw tap at a point. Only Guard.tap may call it, after the deny-list check.
  async tapPoint(x: number, y: number) {
    await this.post("/wda/tap", { x, y });
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, durationSec: number) {
    await this.post("/wda/dragfromtoforduration", { fromX, fromY, toX, toY, duration: durationSec });
  }

  async home() {
    await call(this.base, "POST", "/wda/homescreen", {});
  }

  async close() {
    await call(this.base, "DELETE", `/session/${this.sid}`).catch(() => {});
  }
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json()) as any;
  if (!res.ok || json?.value?.error) {
    throw new Error(`WDA ${method} ${path}: ${json?.value?.message ?? res.status}`);
  }
  return json;
}
