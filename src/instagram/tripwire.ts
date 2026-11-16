// Pages instagram.com shows instead of the feed when something is wrong with
// the session. Any of them during a refresh aborts it and pauses the device
// (convex/instagram/limits.ts TRIPWIRE_PAUSE_MS); the user sees the page only
// if they open the login screen themselves.

export type Tripwire = { kind: "challenge" | "login" | "suspicious"; screenText: string };

const CHALLENGE = /^\/(challenge|auth_platform|accounts\/(two_factor|confirm_email|suspended|disabled)|checkpoint)\b/;
const LOGIN = /^\/accounts\/(login|emailsignup)\b/;
const SUSPICIOUS = /try again later|suspicious|unusual activity|we restrict certain activity|temporarily blocked/i;

export function tripwireFor(href: string, title = ""): Tripwire | null {
  let path: string;
  try {
    const url = new URL(href);
    if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
    path = url.pathname;
  } catch {
    return null;
  }
  const screenText = `${href} ${title}`.trim().slice(0, 300);
  if (CHALLENGE.test(path)) return { kind: /suspended|disabled/.test(path) ? "suspicious" : "challenge", screenText };
  if (LOGIN.test(path)) return { kind: "login", screenText };
  if (SUSPICIOUS.test(title)) return { kind: "suspicious", screenText };
  return null;
}
