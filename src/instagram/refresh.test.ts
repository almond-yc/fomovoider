import { describe, expect, test, vi } from "vitest";
import feedPage from "./__fixtures__/feed-following-page.json";
import ssrHome from "./__fixtures__/ssr-home-scripts.json";
import storiesPage from "./__fixtures__/stories-reels-media.json";
import type { HookMessage } from "./hook";
import { FOLLOWING_URL, HOME_URL } from "./navigation";
import { runRefresh, type RefreshApi, type RefreshDeps } from "./refresh";

const HOME: HookMessage = { type: "ig:ssr", scripts: ssrHome as string[] };
const FOLLOWING: HookMessage = { type: "ig:ssr", scripts: [JSON.stringify(feedPage)] };
const STORIES: HookMessage = {
  type: "ig:response",
  operation: "PolarisStoriesV3ReelPageGalleryQuery",
  status: 200,
  body: JSON.stringify(storiesPage),
};
const feedEdges = (feedPage as any).data.xdt_api__v1__feed__timeline__connection.edges;
const trayReels = (JSON.parse((ssrHome as string[])[0]) as any).require[0][3][0].__bbox.require[0][3][1].__bbox.result.data
  .xdt_api__v1__feed__reels_tray.tray;

function fakePage(pages: Record<string, HookMessage[]> = { [HOME_URL]: [HOME], [FOLLOWING_URL]: [FOLLOWING] }) {
  const listeners = new Set<(m: HookMessage) => void>();
  const emit = (m: HookMessage) => listeners.forEach((l) => l(m));
  return {
    hookKey: "_k",
    goto: vi.fn(async (url: string) => (pages[url] ?? []).forEach(emit)),
    evaluate: vi.fn(async (js: string): Promise<any> => {
      if (js.includes('window["_k"].stories(')) {
        emit(STORIES);
        return 200;
      }
      return null;
    }),
    onMessage: (l: (m: HookMessage) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

function fakeApi(start: Partial<{ knownIds: string[]; kind: string; cursors: any; budget: any }> = {}) {
  const submitted: any[] = [];
  const api = {
    startRefresh: vi.fn(async () =>
      start.kind
        ? ({ kind: start.kind, reason: "kill_switch" } as any)
        : {
            kind: "run" as const,
            runId: "run1",
            trigger: "open",
            budget: start.budget ?? { maxMs: 240_000, maxPosts: 60, maxStoryFrames: 40 },
            cursors: start.cursors ?? {},
            knownIds: start.knownIds ?? [],
          },
    ),
    generateUploadUrl: vi.fn(async () => "https://upload"),
    submit: vi.fn(async (args: any) => {
      submitted.push(...args.items);
      return args.items.length;
    }),
    finish: vi.fn(async () => null),
  } satisfies RefreshApi;
  return { api, submitted };
}

function deps(page: ReturnType<typeof fakePage>, api: RefreshApi, extra: Partial<RefreshDeps> = {}): RefreshDeps {
  let clock = 1_800_000_000_000;
  return {
    page,
    api,
    uploadFile: vi.fn(async (source: string) => "storage:" + source.slice(-20)),
    onWifi: async () => false,
    killed: () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    ...extra,
  };
}

describe("runRefresh", () => {
  test("reads the tray from home, the Following feed, then stories by query, and finishes", async () => {
    const page = fakePage();
    const { api, submitted } = fakeApi();
    const result = await runRefresh("open", deps(page, api));
    expect(page.goto.mock.calls.map((c) => c[0])).toEqual([HOME_URL, FOLLOWING_URL]);
    expect(result).toMatchObject({ outcome: "done", posts: 5, stories: 2 });
    // Home's own ranked feed is not read.
    expect(submitted.filter((i) => i.format === "post")).toHaveLength(5);
    expect(submitted.filter((i) => i.format === "story")).toHaveLength(2);
    const query = page.evaluate.mock.calls.map((c) => c[0]).find((js) => js.includes(".stories("))!;
    expect(query).toContain(JSON.stringify(trayReels.map((r: any) => r.id)));
    const reel = submitted.find((i) => i.facts.isReel);
    expect(reel.media[0]).toMatchObject({ kind: "video" });
    expect(reel.media[0].storageId).toBeUndefined();
    const image = submitted.find((i) => i.media[0]?.kind === "image");
    expect(image.media[0].storageId).toMatch(/^storage:/);
    expect(image.media[0]).not.toHaveProperty("upload");
    const cursorCalls = api.submit.mock.calls.map((c: any) => c[0].feedPage).filter(Boolean);
    expect(cursorCalls[0]).toMatchObject({ variant: "following", hasNextPage: true, newestId: "instagram:" + feedEdges[0].node.media.pk });
    expect(cursorCalls.at(-1)).toMatchObject({ variant: "stories", newestAt: Math.max(...trayReels.map((r: any) => r.latest_reel_media)) * 1000 });
  });

  test("videos upload on Wi-Fi", async () => {
    const { api, submitted } = fakeApi();
    await runRefresh("open", deps(fakePage(), api, { onWifi: async () => true }));
    expect(submitted.find((i) => i.facts.isReel).media[0].storageId).toMatch(/^storage:/);
  });

  test("stops at the first post an earlier refresh stored, by id or by time", async () => {
    const third = "instagram:" + feedEdges[2].node.media.pk;
    for (const start of [{ knownIds: [third] }, { cursors: { following: { hasNextPage: true, newestAt: feedEdges[2].node.media.taken_at * 1000 } } }]) {
      const { api, submitted } = fakeApi(start);
      const result = await runRefresh("open", deps(fakePage(), api));
      expect(result).toMatchObject({ outcome: "done", caughtUp: true });
      expect(submitted.filter((i) => i.format === "post").map((i) => i.id)).toEqual(
        feedEdges.slice(0, 2).map((e: any) => "instagram:" + e.node.media.pk),
      );
    }
  });

  test("a known ad or suggestion is skipped without ending the feed", async () => {
    const ad = "instagram:" + feedEdges[3].node.ad.items[0].pk;
    const suggested = "instagram:" + feedEdges[4].node.explore_story.media.pk;
    const { api, submitted } = fakeApi({ knownIds: [ad, suggested] });
    const result = await runRefresh("open", deps(fakePage(), api));
    expect(result).toMatchObject({ caughtUp: false, posts: 3 });
    expect(submitted.map((i) => i.id)).not.toContain(ad);
  });

  test("only stories updated since the last story pass are fetched", async () => {
    const latest = Math.max(...trayReels.map((r: any) => r.latest_reel_media)) * 1000;
    const page = fakePage();
    const { api } = fakeApi({ cursors: { stories: { hasNextPage: false, newestAt: latest } } });
    const result = await runRefresh("open", deps(page, api));
    expect(result).toMatchObject({ stories: 0 });
    expect(page.evaluate.mock.calls.some((c) => c[0].includes(".stories("))).toBe(false);
  });

  test("media go by URL once the time budget is spent", async () => {
    const { api, submitted } = fakeApi({ budget: { maxMs: 1_000, maxPosts: 60, maxStoryFrames: 40 } });
    const d = deps(fakePage(), api);
    await runRefresh("open", d);
    expect(d.uploadFile).not.toHaveBeenCalled();
    expect(submitted.every((i) => i.media.every((m: any) => m.storageId === undefined))).toBe(true);
  });

  test("a challenge page aborts the refresh before anything is sent", async () => {
    const page = fakePage({ [HOME_URL]: [{ type: "ig:location", href: "https://www.instagram.com/challenge/?next=/", title: "Instagram" }] });
    const { api } = fakeApi();
    const result = await runRefresh("background", deps(page, api));
    expect(result).toMatchObject({ outcome: "aborted", tripwire: { kind: "challenge" } });
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.finish).toHaveBeenCalledWith(expect.objectContaining({ tripwire: expect.objectContaining({ kind: "challenge" }), caughtUp: false }));
  });

  test("the kill switch stops a running refresh", async () => {
    const page = fakePage();
    const { api } = fakeApi();
    const result = await runRefresh("open", deps(page, api, { killed: () => true }));
    expect(result).toMatchObject({ outcome: "failed", error: "kill switch" });
    expect(page.goto).not.toHaveBeenCalled();
  });

  test("a refused start reads nothing", async () => {
    const page = fakePage();
    const { api } = fakeApi({ kind: "blocked" });
    expect((await runRefresh("open", deps(page, api))).outcome).toBe("blocked");
    expect(page.goto).not.toHaveBeenCalled();
    expect(api.finish).not.toHaveBeenCalled();
  });
});
