import type { HookMessage } from "./hook";
import { FOLLOWING_URL, HOME_URL, scrollFeedJs, storyQueryJs } from "./navigation";
import { extract, parseResponseText, type CapturedMedia, type CapturedPost, type FeedPage, type TrayReel } from "./parse";
import { tripwireFor, type Tripwire } from "./tripwire";

// One refresh, following the FOMO-23 spike's recommendation:
// 1. ask Convex for a budget;
// 2. load the home page only for its server-rendered story tray (its ranked
//    feed is not read);
// 3. load the chronological Following feed and scroll at a human pace until
//    reaching the newest post an earlier refresh stored;
// 4. fetch story items with one gallery query per three reels that have
//    something new, without opening the viewer (no "seen" receipts).
// Items stream to Convex as they arrive, with media uploaded from the phone
// first (Instagram's CDN URLs expire after about 4.4 days). Any challenge or
// login page aborts at once.

export interface PageControl {
  goto(url: string): Promise<void>;
  evaluate<T = unknown>(js: string): Promise<T>;
  onMessage(listener: (message: HookMessage) => void): () => void;
  // Where the capture hook exposes its story query (hook.ts).
  hookKey: string;
}

type Budget = { maxMs: number; maxPosts: number; maxStoryFrames: number };
export type CursorState = { endCursor?: string; hasNextPage: boolean; newestId?: string; newestAt?: number };
type Start =
  | { kind: "blocked"; reason: string; until?: number; detail?: string }
  | { kind: "wait"; reason: string; retryAt: number }
  | {
      kind: "run";
      runId: string;
      trigger: string;
      budget: Budget;
      cursors: { home?: CursorState; following?: CursorState; stories?: CursorState };
      knownIds: string[];
    };

export type SubmittedMedia = Omit<CapturedMedia, "upload"> & { storageId?: string };
export type SubmittedItem = Omit<CapturedPost, "media"> & { media: SubmittedMedia[] };
export type CursorUpdate = CursorState & { variant: "following" | "stories" };

export interface RefreshApi {
  startRefresh(args: { trigger: "open" | "background" | "manual" }): Promise<Start>;
  generateUploadUrl(args: { runId: string }): Promise<string>;
  submit(args: { runId: string; items: SubmittedItem[]; feedPage?: CursorUpdate }): Promise<number>;
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
  // Downloads sourceUrl and posts it to uploadUrl within timeoutMs; returns
  // the storage id, or undefined when it failed or ran out of time (ingest
  // then copies the URL itself).
  uploadFile(sourceUrl: string, uploadUrl: string, timeoutMs: number): Promise<string | undefined>;
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

const LOAD_TIMEOUT_MS = 15_000;
// Each media transfer gets the budget's remaining time, at most this much;
// past the budget, media go by URL and ingest copies them.
const MAX_UPLOAD_MS = 30_000;
const MIN_UPLOAD_MS = 2_000;
const MAX_IDLE_SCROLLS = 3;
// Following pages loaded by scrolling, beyond the server-rendered first one.
const MAX_FEED_PAGES = 5;
const REELS_PER_QUERY = 3;
const MAX_STORY_QUERIES = 3;
// Share of the time budget the feed may use before stories get their turn.
const FEED_SHARE = 0.7;

class Abort extends Error {}

export async function runRefresh(trigger: "open" | "background" | "manual", deps: RefreshDeps): Promise<RefreshResult> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const start = await deps.api.startRefresh({ trigger });
  if (start.kind !== "run") return { outcome: start.kind, detail: start };
  const { runId, budget, knownIds, cursors } = start;
  const t0 = now();
  const known = new Set(knownIds);
  const before = cursors.following;
  const storiesSince = cursors.stories?.newestAt ?? 0;
  const sent = new Set<string>();
  const queue: CapturedPost[] = [];
  const tray = new Map<string, TrayReel>();
  const trayOrder = new Map<string, number>();
  let phase: "tray" | "feed" | "stories" = "tray";
  let followingPage: FeedPage | undefined;
  let feedPages = 0;
  let newest: { id: string; at: number } | undefined;
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
    received++;
    for (const reel of parsed.tray) {
      tray.set(reel.reelId, reel);
      trayOrder.set(reel.reelId, reel.position);
    }
    if (phase === "tray") return;
    for (const page of parsed.feedPages) {
      if (page.variant !== "following") continue;
      followingPage = page;
      if (message.type === "ig:response") feedPages++;
    }
    queue.push(...parsed.posts.filter((p) => (phase === "feed" ? p.format === "post" : p.format === "story")));
  });

  const check = () => {
    if (tripwire) throw new Abort("tripwire");
    if (deps.killed()) throw new Abort("kill switch");
  };
  const pause = async (min: number, max: number) => {
    await deps.sleep(min + random() * (max - min));
    check();
  };
  const load = async (url: string) => {
    received = 0;
    await deps.page.goto(url);
    for (let waited = 0; received === 0 && waited < LOAD_TIMEOUT_MS; waited += 500) await pause(500, 500);
    check();
  };

  const uploadMedia = async (post: CapturedPost, wifi: boolean): Promise<SubmittedItem> => {
    const media: SubmittedMedia[] = [];
    for (const { upload, ...m } of post.media) {
      check();
      const source = m.kind === "video" ? (wifi ? upload.video : undefined) : upload.image;
      const left = t0 + budget.maxMs - now();
      let storageId: string | undefined;
      if (source && left > MIN_UPLOAD_MS) {
        const uploadUrl = await deps.api.generateUploadUrl({ runId });
        storageId = await deps.uploadFile(source, uploadUrl, Math.min(left, MAX_UPLOAD_MS));
      }
      media.push(storageId ? { ...m, storageId } : m);
    }
    return { ...post, media };
  };

  // The Following feed is newest first, so everything past the newest post
  // an earlier refresh stored (by id, or by time if that post is gone) is
  // stored already.
  const reachedStored = (post: CapturedPost) =>
    known.has(post.id) ||
    post.id === before?.newestId ||
    (before?.newestAt !== undefined && Date.parse(post.createdAt) <= before.newestAt);

  // cursor is read after this batch is counted, so it carries its newest post.
  const flush = async (cursorOf?: () => CursorUpdate | undefined) => {
    const fresh: CapturedPost[] = [];
    for (const post of queue.splice(0)) {
      if (sent.has(post.id)) continue;
      sent.add(post.id);
      if (post.format === "post") {
        if (caughtUp) continue;
        // Ads and suggestions are not in time order, so they never mark
        // where the feed was read up to; known ones are just skipped.
        const organic = !post.facts.sponsored && !post.facts.suggested;
        if (organic && reachedStored(post)) {
          caughtUp = true;
          continue;
        }
        if (!organic && known.has(post.id)) continue;
        if (posts >= budget.maxPosts) continue;
        posts++;
        if (organic && !newest) newest = { id: post.id, at: Date.parse(post.createdAt) };
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
    const cursor = cursorOf?.();
    if (!items.length && !cursor) return 0;
    await deps.api.submit({ runId, items, ...(cursor ? { feedPage: cursor } : {}) });
    return items.length;
  };

  const followingCursor = (): CursorUpdate | undefined =>
    followingPage && {
      variant: "following",
      endCursor: followingPage.endCursor ?? undefined,
      hasNextPage: followingPage.hasNextPage,
      ...(newest ? { newestId: newest.id, newestAt: newest.at } : {}),
    };

  let error: string | undefined;
  try {
    check();
    await load(HOME_URL);
    await pause(1_000, 2_500);

    phase = "feed";
    await load(FOLLOWING_URL);
    if (!followingPage) throw new Error("The Following feed did not load");
    let idle = 0;
    while (true) {
      const added = await flush(followingCursor);
      idle = added ? 0 : idle + 1;
      if (caughtUp || posts >= budget.maxPosts || idle > MAX_IDLE_SCROLLS || feedPages >= MAX_FEED_PAGES) break;
      if (now() - t0 > budget.maxMs * FEED_SHARE) break;
      if (!followingPage.hasNextPage) {
        caughtUp = true;
        break;
      }
      await deps.page.evaluate(scrollFeedJs(0.6 + random() * 0.35));
      await pause(1_400, 3_800);
    }

    phase = "stories";
    const due = [...tray.values()]
      .filter((r) => (r.latestReelMedia ?? 0) * 1000 > storiesSince)
      .sort((a, b) => a.position - b.position);
    let latest = storiesSince;
    for (let q = 0; q < MAX_STORY_QUERIES && q * REELS_PER_QUERY < due.length; q++) {
      if (stories >= budget.maxStoryFrames || now() - t0 > budget.maxMs) break;
      const chunk = due.slice(q * REELS_PER_QUERY, (q + 1) * REELS_PER_QUERY);
      await pause(2_000, 5_000);
      received = 0;
      const status = await deps.page.evaluate<number>(
        storyQueryJs(deps.page.hookKey, chunk.map((r) => r.reelId), chunk[0].reelId, chunk.length),
      );
      if (status !== 200) throw new Error(`Story query returned HTTP ${status}`);
      for (let waited = 0; received === 0 && waited < LOAD_TIMEOUT_MS; waited += 250) await pause(250, 250);
      await flush();
      // Reels whose items didn't all fit the budget are fetched again next time.
      if (stories >= budget.maxStoryFrames) break;
      for (const reel of chunk) latest = Math.max(latest, (reel.latestReelMedia ?? 0) * 1000);
      await flush(() => ({ variant: "stories", hasNextPage: due.length > (q + 1) * REELS_PER_QUERY, newestAt: latest }));
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
