import { createHash } from "node:crypto";
import { find, findAll, text, walk, type Node } from "./tree.ts";

// Pure readers for Instagram's iOS accessibility tree (v4xx, Nov 2026).
// The feed is one collection view ("main-feed") whose cells are the parts of
// each post in order: header, media, actions, "Liked by", caption, time.

const UNIT_MS: Record<string, number> = {
  second: 1e3,
  minute: 60e3,
  hour: 3600e3,
  day: 86400e3,
  week: 7 * 86400e3,
  month: 30 * 86400e3,
  year: 365 * 86400e3,
};

// "2 days ago", "1 hour ago", "Just now", "Yesterday" -> epoch ms.
export function parseAge(age: string, now: number): number | undefined {
  const m = age.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (m) return now - Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
  if (/just now/i.test(age)) return now;
  if (/yesterday/i.test(age)) return now - UNIT_MS.day;
  const short = age.match(/^(\d+)([smhdw])$/);
  if (short) return now - Number(short[1]) * UNIT_MS[{ s: "second", m: "minute", h: "hour", d: "day", w: "week" }[short[2]]!];
  return undefined;
}

const AGE = "\\d+ (?:second|minute|hour|day|week|month|year)s? ago|Just now|Yesterday";

export type Header = {
  handle: string;
  coAuthors: string[];
  location?: string;
  age?: string;
  sponsored: boolean;
  suggested: boolean;
};

// header-view's value, e.g. "Post by alice, taken at Berkeley University,
// 2 days ago", "Post by brand, Ad, 2 weeks ago",
// "Post by bob, taken 1 hour ago, Suggested for you".
export function parseHeader(value: string): Header | undefined {
  const by = value.match(/^Post by (.+?)(?=, |$)/);
  if (!by) return undefined;
  const [handle, ...coAuthors] = by[1].split(/ and |, /).map((s) => s.trim());
  const age = value.match(new RegExp(`(?:, |, taken )(${AGE})`, "i"))?.[1];
  const location = value.match(new RegExp(`, taken at (.+?), (?:(?:Ad|Sponsored), )?(?:${AGE})`, "i"))?.[1];
  return {
    handle,
    coAuthors,
    location,
    age,
    sponsored: /, (Ad|Sponsored|Paid partnership)(,|$)/.test(value),
    suggested: /Suggested (for you|posts)/i.test(value),
  };
}

export type FeedPart = {
  headerValue?: string;
  header?: Header;
  followsAuthor?: boolean;
  media?: { label: string; kind: "image" | "video"; rect: Rect; carousel?: number };
  caption?: string;
  age?: string;
};

export type Rect = { x: number; y: number; width: number; height: number };

// Cells of the main feed in screen order, grouped into posts. The first
// group may lack a header when its header scrolled off the top: the caller
// merges it into the post it already holds.
// carryHandle is the author of the post whose header scrolled off, so its
// caption can still be recognized in the leading headerless cells.
export function readFeedScreen(root: Node, carryHandle?: string): FeedPart[] | undefined {
  const feed = find(root, (n) => n.name === "main-feed");
  if (!feed) return undefined;
  const parts: FeedPart[] = [];
  let current: FeedPart | undefined = { };
  for (const cell of feed.children) {
    if (cell.type !== "Cell") continue;
    const header = find(cell, (n) => n.name === "header-view" && !!n.value);
    if (cell.name === "stories-tray" || isSuggestionModule(cell)) {
      current = undefined;
      continue;
    }
    if (header?.value) {
      const parsed = parseHeader(header.value);
      current = { headerValue: header.value, header: parsed };
      parts.push(current);
      const follow = find(cell, (n) => n.name === "follow-button");
      if (parsed) current.followsAuthor = !follow;
    } else if (current && parts.length === 0) {
      parts.push(current);
    }
    if (!current) continue;
    const media = find(cell, (n) => /^(Photo|Video|Reel) by /.test(n.label ?? ""));
    if (media && !current.media) {
      const frame = find(cell, (n) => n.name === "media-cell") ?? media;
      const carousel = [...walk(cell)]
        .map((n) => n.value?.match(/, 1 of (\d+),/)?.[1])
        .find(Boolean);
      current.media = {
        label: media.label!,
        kind: /^Photo/.test(media.label!) ? "image" : "video",
        rect: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        carousel: carousel ? Number(carousel) : undefined,
      };
    }
    const handle = current.header?.handle ?? (parts[0] === current && !current.headerValue ? carryHandle : undefined);
    const caption =
      handle && !header && !media
        ? findAll(cell, (n) => n.type === "StaticText" || n.type === "Other")
            .map(text)
            .find((t) => t.startsWith(`${handle} `) && t.length > handle.length + 1)
        : undefined;
    if (caption && current.caption === undefined) {
      current.caption = caption.slice(handle!.length + 1).replace(/…\s*more$/, "…").trim();
    }
    const age = findAll(cell, (n) => n.type === "StaticText" || n.type === "Other")
      .map(text)
      .find((t) => new RegExp(`^(${AGE})`, "i").test(t));
    if (age && !current.age) current.age = age.split(" ⋅ ")[0];
  }
  return parts;
}

function isSuggestionModule(cell: Node) {
  return !!find(
    cell,
    (n) => /^(Suggested for you|Dismiss suggestion|More options for suggested accounts)$/.test(n.label ?? ""),
  ) && !find(cell, (n) => n.name === "header-view");
}

export type StoryFrame = {
  handle: string;
  age?: string;
  sponsored: boolean;
  stickers: string[];
  overlay: Rect;
  buttons: Rect[];
};

const STORY_CONTROLS = /Profile picture|^story-header$|Info about this story|Close stories|Send message|^Like$|^Share$|^Send$|Reply|More|Mute|Unmute|Pause|facepile|Learn more|Watch full reel/i;

// The full-screen story viewer, or undefined when it is not showing.
export function readStoryFrame(root: Node): StoryFrame | undefined {
  const overlay = find(root, (n) => n.name === "story-fullscreen-overlay-view" && n.visible);
  if (!overlay) return undefined;
  // Friends' stories have a "story-header" button; ads and collabs only a
  // text block ("brand and partner") next to the avatar.
  const header =
    find(overlay, (n) => n.name === "story-header") ??
    find(
      overlay,
      (n) =>
        n.type === "Other" &&
        !!n.label &&
        n.name === n.label &&
        n.y < overlay.y + 80 &&
        n.x > 40 &&
        n.x < 200 &&
        !/Profile picture/.test(n.label),
    );
  const handle = (
    header?.label?.match(/^(.+?)'s story/)?.[1] ??
    (header && find(header, (n) => n.type === "StaticText")?.label) ??
    header?.label
  )?.split(" and ")[0];
  if (!header || !handle) return undefined;
  const age = findAll(overlay, (n) => n.type === "StaticText")
    .map(text)
    .find((t) => new RegExp(`^(${AGE})$`, "i").test(t) || /^\d+[smhdw]$/.test(t));
  const buttons = findAll(overlay, (n) => n.type === "Button" && n.visible);
  const stickers = buttons
    .filter((b) => b.y > header.y + 40 && b.y < overlay.y + overlay.height - 110)
    .map(text)
    .filter((t) => t && !STORY_CONTROLS.test(t) && t !== handle);
  return {
    handle,
    age,
    sponsored: !!find(overlay, (n) => /^(Ad|Sponsored|Paid partnership.*)$/.test(text(n))),
    stickers: [...new Set(stickers)],
    overlay: { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height },
    buttons: buttons.map((b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
  };
}

export type TrayEntry = { handle: string; seen: boolean; position: number; node: Node };

export function readStoryTray(root: Node): TrayEntry[] {
  return findAll(root, (n) => n.name?.startsWith("story-tray-cell-") === true && n.name !== "story-tray-cell-self")
    .map((n, i) => ({
      handle: n.name!.slice("story-tray-cell-".length),
      seen: /, Seen$/.test(n.label ?? ""),
      position: i + 1,
      node: n,
    }));
}

export function readProfile(root: Node) {
  const title = find(root, (n) => n.name === "user-switch-title-button");
  if (!title?.label) return undefined;
  const nameNode = find(
    root,
    (n) => n.type === "Other" && !!n.label && n.name === n.label && n.y > 100 && n.y < 160 && n.x > 100,
  );
  return { handle: title.label, displayName: nameNode?.label ?? title.label };
}

// Text that is not someone's content: everything outside the feed and the
// story viewer, plus alerts. Tripwires only look at this.
export function chromeText(root: Node) {
  const out: string[] = [];
  const visit = (n: Node) => {
    if (n.name === "main-feed" || n.name === "story-fullscreen-overlay-view") return;
    if (n.visible && text(n)) out.push(text(n));
    n.children.forEach(visit);
  };
  visit(root);
  return out.join("\n");
}

export function postId(parts: string[]) {
  return `instagram:${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24)}`;
}
