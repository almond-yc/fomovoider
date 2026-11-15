import type { HookMessage } from "./hook";
import {
  CLOSE_STORIES_JS,
  FOLLOWING_URL,
  IN_STORY_VIEWER_JS,
  NEXT_REEL_JS,
  OPEN_STORY_TRAY_JS,
  SCROLL_TOP_JS,
  scrollFeedJs,
} from "./navigation";
import { extract, parseResponseText, type CapturedMedia, type CapturedPost, type FeedPage } from "./parse";
import { tripwireFor, type Tripwire } from "./tripwire";

// One refresh: ask Convex for a budget, open the chronological Following
// feed, read what the page itself loads while scrolling at a human pace,
// then open the story tray and skip through people's stories. Items stream
// to Convex as they arrive, with their media uploaded from the phone first
// (Instagram's CDN URLs expire). Any challenge or login page aborts at once.

export interface PageControl {
  goto(url: string): Promise<void>;
  evaluate<T = unknown>(js: string): Promise<T>;
  onMessage(listener: (message: HookMessage) => void): () => void;
}

type Budget = { maxMs: number; maxPosts: number; maxStoryFrames: number };
type Cursor = { endCursor?: string; hasNextPage: boolean; newestId?: string };
type Start =
  | { kind: "blocked"; reason: string; until?: number; detail?: string }
  | { kind: "wait"; reason: string; retryAt: number }
  | {
      kind: "run";
      runId: string;
      trigger: string;
      budget: Budget;
      cursors: { home?: Cursor; following?: Cursor };
      knownIds: string[];
    };

export type SubmittedMedia = Omit<CapturedMedia, "upload"> & { storageId?: string };
export type SubmittedItem = Omit<CapturedPost, "media"> & { media: SubmittedMedia[] };

export interface RefreshApi {
  startRefresh(args: { trigger: "open" | "background" | "manual" }): Promise<Start>;
  generateUploadUrl(args: { runId: string }): Promise<string>;
  submit(args: {
    runId: string;
    items: SubmittedItem[];
    feedPage?: { variant: "home" | "following"; endCursor?: string; hasNextPage: boolean; newestId?: string };
  }): Promise<number>;
  finish(args: {
    runId: string;
    stats: { posts: number; storyFrames: number; durationMs: number };
    tripwire?: Tripwire;
    error?: string;
    caughtUp?: boolean;
  }): Promise<unknown>;
}

export interface RefreshDeps {
  page: PageControl;
  api: RefreshApi;
  // Downloads sourceUrl and posts it to uploadUrl; returns the storage id,
  // or undefined when it failed (ingest then copies the URL itself).
  uploadFile(sourceUrl: string, uploadUrl: string): Promise<string | undefined>;
  // Videos upload only on Wi-Fi.
  onWifi(): Promise<boolean>;
  // True once the kill switch is on (convex instagram/webview:state).
  killed(): boolean;
  sleep(ms: number): Promise<void>;
  now?: () => number;
  random?: () => number;
}

export type RefreshResult =
  | { outcome: "blocked" | "wait"; detail: Start }
  | {
      outcome: "done" | "aborted" | "failed";
      runId: string;
      posts: number;
      stories: number;
      caughtUp: boolean;
      tripwire?: Tripwire;
      error?: string;
    };

const FIRST_PAGE_TIMEOUT_MS = 15_000;
const MAX_IDLE_SCROLLS = 3;
const MAX_REELS = 12;
// Share of the time budget the feed may use before stories get their turn.
const FEED_SHARE = 0.65;

class Abort extends Error {}

export async function runRefresh(trigger: "open" | "background" | "manual", deps: RefreshDeps): Promise<RefreshResult> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const start = await deps.api.startRefresh({ trigger });
  if (start.kind !== "run") return { outcome: start.kind, detail: start };
  const { runId, budget, knownIds, cursors } = start;
  const t0 = now();
  const known = new Set(knownIds);
  const newestBefore = cursors.following?.newestId;
  const sent = new Set<string>();
  const queue: CapturedPost[] = [];
  const trayOrder = new Map<string, number>();
  let followingPage: FeedPage | undefined;
  let newestId: string | undefined;
  let tripwire: Tripwire | undefined;
  let caughtUp = false;
  let posts = 0;
  let stories = 0;
  let received = 0;

  const unsubscribe = deps.page.onMessage((message) => {
    if (message.type === "ig:location") {
      tripwire ??= tripwireFor(message.href, message.title) ?? undefined;
      return;
    }
    const docs =
      message.type === "ig:ssr"
        ? message.scripts.flatMap(parseResponseText)
        : message.type === "ig:response" && message.status === 200
          ? parseResponseText(message.body)
          : [];
    if (!docs.length) return;
    const parsed = extract(docs, trayOrder);
    for (const reel of parsed.tray) trayOrder.set(reel.reelId, reel.position);
    for (const page of parsed.feedPages) if (page.variant === "following") followingPage = page;
    queue.push(...parsed.posts);
    received++;
  });

  const check = () => {
    if (tripwire) throw new Abort("tripwire");
    if (deps.killed()) throw new Abort("kill switch");
  };
  const pause = async (min: number, max: number) => {
    await deps.sleep(min + random() * (max - min));
    check();
  };

  const uploadMedia = async (post: CapturedPost, wifi: boolean): Promise<SubmittedItem> => {
    const media: SubmittedMedia[] = [];
    for (const { upload, ...m } of post.media) {
      const source = m.kind === "video" ? (wifi ? upload.video : undefined) : upload.image;
      let storageId: string | undefined;
      if (source) {
        const uploadUrl = await deps.api.generateUploadUrl({ runId });
        storageId = await deps.uploadFile(source, uploadUrl);
      }
      media.push(storageId ? { ...m, storageId } : m);
    }
    return { ...post, media };
  };

  // Sends everything captured so far. Returns how many new feed posts it
  // sent; sets caughtUp once the feed reaches a post an earlier run stored.
  const flush = async () => {
    const batch = queue.splice(0).filter((p) => !sent.has(p.id));
    const fresh: CapturedPost[] = [];
    for (const post of batch) {
      sent.add(post.id);
      if (post.format === "post") {
        // The Following feed is chronological: past the first post an
        // earlier refresh stored, everything is older and stored too.
        if (caughtUp) continue;
        if (known.has(post.id) || post.id === newestBefore) {
          caughtUp = true;
          continue;
        }
        if (posts >= budget.maxPosts) continue;
        posts++;
        newestId ??= post.id;
      } else {
        if (known.has(post.id) || stories >= budget.maxStoryFrames) continue;
        stories++;
      }
      fresh.push(post);
    }
    const wifi = fresh.some((p) => p.media.some((m) => m.kind === "video")) ? await deps.onWifi() : false;
    const items: SubmittedItem[] = [];
    for (const post of fresh) items.push(await uploadMedia(post, wifi));
    check();
    await deps.api.submit({
      runId,
      items,
      ...(followingPage
        ? {
            feedPage: {
              variant: "following" as const,
              endCursor: followingPage.endCursor ?? undefined,
              hasNextPage: followingPage.hasNextPage,
              newestId,
            },
          }
        : {}),
    });
    return fresh.filter((p) => p.format === "post").length;
  };

  let error: string | undefined;
  try {
    check();
    await deps.page.goto(FOLLOWING_URL);
    for (let waited = 0; received === 0 && waited < FIRST_PAGE_TIMEOUT_MS; waited += 500) await pause(500, 500);
    if (received === 0) throw new Error("The Following feed did not load");

    let idle = 0;
    while (true) {
      const added = await flush();
      idle = added ? 0 : idle + 1;
      const feedTime = now() - t0 > budget.maxMs * FEED_SHARE;
      if (caughtUp || posts >= budget.maxPosts || feedTime || idle > MAX_IDLE_SCROLLS) break;
      if (followingPage && !followingPage.hasNextPage) {
        caughtUp = true;
        break;
      }
      await deps.page.evaluate(scrollFeedJs(0.6 + random() * 0.35));
      await pause(1_400, 3_800);
    }

    if (budget.maxStoryFrames > 0 && now() - t0 < budget.maxMs) {
      await deps.page.evaluate(SCROLL_TOP_JS);
      await pause(800, 1_600);
      if (await deps.page.evaluate<boolean>(OPEN_STORY_TRAY_JS)) {
        for (let reel = 0; reel < MAX_REELS; reel++) {
          await pause(2_000, 4_000);
          await flush();
          if (stories >= budget.maxStoryFrames || now() - t0 > budget.maxMs) break;
          if (!(await deps.page.evaluate<boolean>(IN_STORY_VIEWER_JS))) break;
          if (!(await deps.page.evaluate<boolean>(NEXT_REEL_JS))) break;
        }
        if (await deps.page.evaluate<boolean>(IN_STORY_VIEWER_JS)) await deps.page.evaluate(CLOSE_STORIES_JS);
      }
      await flush();
    }
  } catch (err) {
    if (!(err instanceof Abort)) error = err instanceof Error ? err.message : String(err);
    else if (!tripwire) error = err.message;
  } finally {
    unsubscribe();
  }

  const outcome = tripwire ? "aborted" : error ? "failed" : "done";
  await deps.api.finish({
    runId,
    stats: { posts, storyFrames: stories, durationMs: now() - t0 },
    ...(tripwire ? { tripwire } : {}),
    ...(error ? { error } : {}),
    caughtUp: !tripwire && !error && caughtUp,
  });
  return { outcome, runId, posts, stories, caughtUp, ...(tripwire ? { tripwire } : {}), ...(error ? { error } : {}) };
}
