import type { Node } from "./tree.ts";
import { text } from "./tree.ts";
import type { Wda } from "./wda.ts";

// Read-only enforcement: the agent never taps anything that could write to
// Instagram. Every tap goes through Guard.tap, which refuses elements whose
// label matches the deny-list.
const DENY =
  /\b(like|unlike|follow|following|unfollow|comment|reply|share|send|message|save|saved|remove|repost|remix|add to|post|edit|delete|report|block|mute|restrict|subscribe|log ?out|log ?in|sign ?in|switch accounts?|settings|add account|create|new post|story reply|react)\b|❤|♥/i;

// Screens that mean Instagram is suspicious of the session, or that the
// session is gone. Any match aborts the run and pauses the device for 72 h.
const TRIPWIRES: { kind: "challenge" | "login" | "suspicious"; pattern: RegExp }[] = [
  { kind: "challenge", pattern: /confirm (it'?s|that it'?s) you|help us confirm|security code|enter the code|we sent a code|verify your (account|identity)|captcha|checkpoint/i },
  { kind: "login", pattern: /log into instagram|log in to instagram|forgot password|create new account|your session (has )?expired|you('ve| have) been logged out|username, email or mobile/i },
  { kind: "suspicious", pattern: /suspicious activity|unusual activity|automated behavio|we limit how often|try again later|action blocked|we restrict certain activity|account (has been )?(suspended|disabled)|temporarily (locked|blocked)/i },
];

export class Tripwire extends Error {
  readonly kind: "challenge" | "login" | "suspicious";
  readonly screenText: string;

  constructor(kind: "challenge" | "login" | "suspicious", screenText: string) {
    super(`Tripwire (${kind})`);
    this.kind = kind;
    this.screenText = screenText;
  }
}

export function checkTripwire(screenText: string) {
  for (const { kind, pattern } of TRIPWIRES) {
    const m = screenText.match(pattern);
    if (m) throw new Tripwire(kind, m[0]);
  }
}

export function isDenied(label: string) {
  return DENY.test(label);
}

export async function tap(wda: Wda, node: Node, allowed: RegExp) {
  const label = text(node);
  if (!allowed.test(label) || isDenied(label)) {
    throw new Error(`Refusing to tap "${label}"`);
  }
  await wda.tapPoint(node.x + node.width / 2, node.y + node.height / 2);
}
