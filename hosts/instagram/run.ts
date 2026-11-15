import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { Id } from "../../convex/_generated/dataModel.js";
import { RUN_BUDGET, STORY_TTL_MS } from "../../convex/instagram/limits.ts";
import { cropJpeg } from "./capture.ts";
import { checkTripwire, tap, Tripwire } from "./guard.ts";
import { dwell, nextStoryFrame, rand, scrollFeed, sleep } from "./pacing.ts";
import {
  chromeText,
  parseAge,
  postId,
  readFeedScreen,
  readProfile,
  readStoryFrame,
  readStoryTray,
  type FeedPart,
  type Rect,
} from "./parse.ts";
import { find, parseSource, type Node } from "./tree.ts";
import { Wda } from "./wda.ts";

const INSTAGRAM = "com.burbn.instagram";
const SAFE_TAPS = /^(Main feed|Profile|Button, .+'s story, (Unseen|Seen)|Close stories to return to feed)$/;
// Feed and story media sit between the status bar and the floating tab bar.
const VIEW_TOP = 47;
const VIEW_BOTTOM = 760;

type Budget = typeof RUN_BUDGET;
type Item = {
  id: string;
  author: { id: string; platform: string; handle: string; displayName: string; profileUrl: string };
  createdAt: string;
  text: string;
  permalink: string;
  format: "post" | "story";
  expiresAt?: string;
  extracted?: { place?: { name: string } };
  media: { storageId: Id<"_storage">; kind: "image" | "video"; width?: number; height?: number; altText?: string }[];
  facts: { sponsored: boolean; suggested: boolean; isReel: boolean; followsAuthor?: boolean; storyTrayPosition?: number };
};

function person(handle: string, displayName = handle) {
  return {
    id: `instagram:${handle}`,
    platform: "instagram",
    handle,
    displayName,
    profileUrl: `https://www.instagram.com/${handle}/`,
  };
}

export class Session {
  private deadline: number;
  private size = { width: 390, height: 844 };
  stats = { posts: 0, storyFrames: 0, durationMs: 0 };
  private started = Date.now();

  private budget: Budget;
  private wda: Wda;
  private convex: ConvexHttpClient;
  private token: string;
  private runId: Id<"instagram_runs">;
  private knownIds: Set<string>;
  private log: (msg: string) => void;

  constructor(
    wda: Wda,
    convex: ConvexHttpClient,
    token: string,
    runId: Id<"instagram_runs">,
    budget: Budget,
    knownIds: Set<string>,
    log: (msg: string) => void,
  ) {
    this.wda = wda;
    this.convex = convex;
    this.token = token;
    this.runId = runId;
    this.knownIds = knownIds;
    this.log = log;
    const capped = {
      maxMs: Math.min(budget.maxMs, RUN_BUDGET.maxMs),
      maxPosts: Math.min(budget.maxPosts, RUN_BUDGET.maxPosts),
      maxStoryFrames: Math.min(budget.maxStoryFrames, RUN_BUDGET.maxStoryFrames),
    };
    this.budget = capped;
    this.deadline = this.started + capped.maxMs - 20_000;
  }

  private timeLeft() {
    return this.deadline - Date.now();
  }

  // Reads the screen and aborts on any challenge, login or warning screen.
  private async screen(): Promise<Node> {
    const root = parseSource(await this.wda.source());
    checkTripwire(chromeText(root));
    return root;
  }

  private async tapNamed(root: Node, name: string) {
    const node = find(root, (n) => n.name === name);
    if (!node) throw new Error(`No ${name} on screen`);
    await tap(this.wda, node, SAFE_TAPS);
  }

  private async upload(jpeg: Buffer) {
    const url = await this.convex.mutation(api.instagram.agent.generateUploadUrl, { token: this.token });
    const res = await fetch(url, { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array(jpeg) });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return (await res.json()).storageId as Id<"_storage">;
  }

  private async submit(items: Item[]) {
    if (items.length === 0) return;
    await this.convex.mutation(api.instagram.agent.submitItems, { token: this.token, runId: this.runId, items });
  }

  async start() {
    this.size = await this.wda.windowSize();
    await dwell(2500, 5000);
  }

  // account().me, from the profile tab's title.
  async identity() {
    let root = await this.screen();
    await this.tapNamed(root, "profile-tab");
    await dwell(1500, 3000);
    root = await this.screen();
    const profile = readProfile(root);
    if (!profile) throw new Error("Could not read the profile tab");
    await this.tapNamed(root, "mainfeed-tab");
    await dwell(1500, 2500);
    const status = await this.convex.mutation(api.instagram.agent.reportIdentity, {
      token: this.token,
      runId: this.runId,
      me: person(profile.handle, profile.displayName),
    });
    this.log(`identity @${profile.handle}: account ${status}`);
    return status;
  }

  // Opens the first unseen story in the tray and watches frames until the
  // viewer reaches stories seen before this run, closes, or the budget ends.
  async stories() {
    let root = await this.screen();
    const tray = readStoryTray(root);
    const positions = new Map(tray.map((t) => [t.handle, t.position]));
    const seenBefore = new Set(tray.filter((t) => t.seen).map((t) => t.handle));
    // Start at the first unseen story and stop where already seen ones begin;
    // when everything is seen (watched on the phone by hand), walk the tray
    // from the start and stop once frames repeat earlier captures.
    const firstUnseen = tray.find((t) => !t.seen);
    const first = firstUnseen ?? tray[0];
    if (!first) return this.log("stories: tray is empty");
    if (!firstUnseen) seenBefore.clear();
    this.log(`stories: tray of ${tray.length}, ${tray.filter((t) => !t.seen).length} unseen, opening @${first.handle}`);
    await tap(this.wda, first.node, SAFE_TAPS);
    let opened = false;
    for (let i = 0; i < 4 && !opened; i++) {
      await dwell(1200, 2000);
      opened = !!readStoryFrame(await this.screen());
    }
    if (!opened) return this.log("stories: the viewer did not open");
    let knownStreak = 0;
    const storyDeadline = Date.now() + Math.min(this.timeLeft() * 0.45, 3.5 * 60_000);
    const items: Item[] = [];
    let lastHandle = "";
    let frameInHandle = 0;
    while (this.stats.storyFrames < this.budget.maxStoryFrames && Date.now() < storyDeadline) {
      await dwell(1800, 4200);
      const png = await this.wda.screenshot();
      root = await this.screen();
      const frame = readStoryFrame(root);
      if (!frame) {
        this.log("stories: viewer closed");
        break;
      }
      if (frame.handle !== lastHandle) {
        if (seenBefore.has(frame.handle)) break;
        lastHandle = frame.handle;
        frameInHandle = 0;
      }
      frameInHandle++;
      const now = Date.now();
      const created = (frame.age && parseAge(frame.age, now)) || now;
      const createdHour = Math.round(created / 3_600_000);
      const id = postId([frame.handle, "story", String(createdHour), String(frameInHandle), ...frame.stickers]);
      if (this.knownIds.has(id)) {
        if (++knownStreak >= 4) break;
        await this.advanceStory(frame.buttons);
        continue;
      }
      knownStreak = 0;
      const media: Rect = { x: 0, y: frame.overlay.y, width: this.size.width, height: VIEW_BOTTOM - frame.overlay.y };
      const crop = cropJpeg(png, media, this.size.width);
      items.push({
        id,
        author: person(frame.handle),
        createdAt: new Date(created).toISOString(),
        text: frame.stickers.join(" · "),
        permalink: `https://www.instagram.com/stories/${frame.handle}/`,
        format: "story",
        expiresAt: new Date(created + STORY_TTL_MS).toISOString(),
        media: [{ storageId: await this.upload(crop.jpeg), kind: "image", width: crop.width, height: crop.height }],
        facts: {
          sponsored: frame.sponsored,
          suggested: false,
          isReel: false,
          followsAuthor: positions.has(frame.handle) ? true : undefined,
          storyTrayPosition: positions.get(frame.handle),
        },
      });
      this.stats.storyFrames++;
      if (items.length >= 8) await this.submit(items.splice(0));
      await this.advanceStory(frame.buttons);
    }
    await this.submit(items);
    root = await this.screen();
    if (readStoryFrame(root)) await this.tapNamed(root, "story-dismiss-button");
    await dwell(1500, 3000);
    this.log(`stories: ${this.stats.storyFrames} frames`);
  }

  // Taps the right edge of the frame at a point no sticker or control covers.
  private async advanceStory(buttons: Rect[]) {
    for (let i = 0; i < 10; i++) {
      const x = this.size.width * rand(0.82, 0.93);
      const y = this.size.height * rand(0.35, 0.6);
      if (!buttons.some((b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height)) {
        await this.wda.tapPoint(x, y);
        return;
      }
    }
    await nextStoryFrame(this.wda, { width: this.size.width, height: this.size.height * 0.3 });
  }

  // Scrolls the home feed, assembling each post from its cells across
  // screens, and stops at already captured posts, the budget, or the end.
  async feed() {
    let root = await this.screen();
    await this.tapNamed(root, "mainfeed-tab");
    await dwell(2000, 3500);
    type Pending = FeedPart & { firstSeen: number; crop?: { jpeg: Buffer; width: number; height: number; fraction: number } };
    const pending = new Map<string, Pending>();
    const order: string[] = [];
    let current: string | undefined;
    let knownStreak = 0;
    let idleScreens = 0;
    const flush = async (keys: string[]) => {
      const items: Item[] = [];
      for (const key of keys) {
        const p = pending.get(key)!;
        pending.delete(key);
        if (!p.header || !p.crop) continue;
        const now = Date.now();
        const created = (p.header.age && parseAge(p.header.age, now)) || (p.age && parseAge(p.age, now)) || now;
        const id = postId([p.header.handle, p.media?.label ?? "", p.caption ?? p.header.location ?? ""]);
        if (this.knownIds.has(id)) {
          knownStreak++;
          continue;
        }
        knownStreak = 0;
        items.push({
          id,
          author: person(p.header.handle),
          createdAt: new Date(created).toISOString(),
          text: p.caption ?? "",
          permalink: `https://www.instagram.com/${p.header.handle}/`,
          format: "post",
          extracted: p.header.location ? { place: { name: p.header.location } } : undefined,
          media: [
            {
              storageId: await this.upload(p.crop.jpeg),
              kind: "image",
              width: p.crop.width,
              height: p.crop.height,
              altText: p.media?.label.replace(/Contains product tags$/, "").trim(),
            },
          ],
          facts: {
            sponsored: p.header.sponsored,
            suggested: p.header.suggested,
            isReel: p.media?.kind === "video",
            followsAuthor: p.followsAuthor,
          },
        });
        this.stats.posts++;
      }
      await this.submit(items);
    };

    while (this.stats.posts + pending.size < this.budget.maxPosts && this.timeLeft() > 0 && knownStreak < 3) {
      const parts = readFeedScreen(root) ?? [];
      let needShot: { key: string; rect: Rect; fraction: number }[] = [];
      parts.forEach((part, i) => {
        let key = part.headerValue;
        if (!key) {
          if (i !== 0 || !current) return;
          key = current;
        }
        let p = pending.get(key);
        if (!p) {
          if (!part.header) return;
          if (order.includes(key)) return;
          p = { ...part, firstSeen: Date.now() };
          pending.set(key, p);
          order.push(key);
        }
        // Media seen apart from its header must name the same author, so a
        // neighbour's photo is never attached to this post.
        const owners = [p.header!.handle, ...p.header!.coAuthors];
        const mediaFits =
          !!part.media && (part.headerValue === key || owners.some((h) => part.media!.label.includes(` by ${h}`)));
        if (mediaFits) p.media ??= part.media;
        p.caption ??= part.caption;
        p.age ??= part.age;
        current = key;
        if (part.media && mediaFits) {
          const r = part.media.rect;
          const top = Math.max(r.y, VIEW_TOP);
          const bottom = Math.min(r.y + r.height, VIEW_BOTTOM);
          const fraction = Math.max(0, bottom - top) / r.height;
          if (fraction > (p.crop?.fraction ?? 0) + 0.05 && fraction >= 0.5) {
            needShot.push({ key, rect: { x: r.x, y: top, width: r.width, height: bottom - top }, fraction });
          }
        }
      });
      if (needShot.length) {
        const png = await this.wda.screenshot();
        for (const s of needShot) {
          pending.get(s.key)!.crop = { ...cropJpeg(png, s.rect, this.size.width), fraction: s.fraction };
        }
      }
      // Posts whose header is two screens behind are complete.
      const done = [...pending.keys()].filter((k) => k !== current && !parts.some((p) => p.headerValue === k));
      await flush(done);
      if (parts.length === 0 && ++idleScreens > 3) {
        this.log("feed: left the feed screen");
        break;
      }
      if (parts.length) idleScreens = 0;
      this.log(`feed: screen with ${parts.length} parts, ${pending.size} pending, ${this.stats.posts} captured`);
      await dwell(1200, 3500);
      await scrollFeed(this.wda, this.size);
      await sleep(600);
      root = await this.screen();
    }
    await flush([...pending.keys()]);
    this.log(`feed: ${this.stats.posts} posts`);
  }

  finish() {
    this.stats.durationMs = Date.now() - this.started;
    return this.stats;
  }
}

export async function executeRun(opts: {
  wdaBase: string;
  convex: ConvexHttpClient;
  token: string;
  run: { runId: Id<"instagram_runs">; budget: Budget; knownIds: string[] };
  log: (msg: string) => void;
}) {
  const { convex, token, run, log } = opts;
  const wda = await Wda.launch(opts.wdaBase, INSTAGRAM);
  const session = new Session(wda, convex, token, run.runId, run.budget, new Set(run.knownIds), log);
  try {
    await session.start();
    const status = await session.identity();
    if (status === "active") {
      await session.stories();
      await session.feed();
    }
    await convex.mutation(api.instagram.agent.finishRun, { token, runId: run.runId, stats: session.finish() });
  } catch (err) {
    const stats = session.finish();
    if (err instanceof Tripwire) {
      log(`TRIPWIRE ${err.kind}: ${err.screenText}; pausing 72 h`);
      await convex.mutation(api.instagram.agent.finishRun, {
        token,
        runId: run.runId,
        stats,
        tripwire: { kind: err.kind, screenText: err.screenText },
      });
    } else {
      log(`run failed: ${(err as Error).stack ?? err}`);
      await convex.mutation(api.instagram.agent.finishRun, { token, runId: run.runId, stats, error: String((err as Error).message ?? err) });
    }
  } finally {
    await wda.home().catch(() => {});
    await wda.close();
  }
  return session.stats;
}
