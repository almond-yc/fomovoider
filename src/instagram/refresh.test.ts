import { describe, expect, test, vi } from "vitest";
import feedPage from "./__fixtures__/feed-following-page.json";
import storiesPage from "./__fixtures__/stories-reels-media.json";
import type { HookMessage } from "./hook";
import { IN_STORY_VIEWER_JS, NEXT_REEL_JS, OPEN_STORY_TRAY_JS } from "./navigation";
import { runRefresh, type RefreshApi, type RefreshDeps } from "./refresh";

const FEED: HookMessage = {
  type: "ig:response",
  operation: "PolarisFeedRootPaginationCachedQuery_subscribe",
  status: 200,
  body: JSON.stringify(feedPage),
};
const STORIES: HookMessage = {
  type: "ig:response",
  operation: "PolarisStoriesV3ReelPageGalleryQuery",
  status: 200,
  body: JSON.stringify(storiesPage),
};

function fakePage(onGoto: HookMessage[] = [FEED]) {
  const listeners = new Set<(m: HookMessage) => void>();
  const emit = (m: HookMessage) => listeners.forEach((l) => l(m));
  let inViewer = false;
  const page = {
    goto: vi.fn(async () => onGoto.forEach(emit)),
    evaluate: vi.fn(async (js: string): Promise<any> => {
      if (js === OPEN_STORY_TRAY_JS) {
        inViewer = true;
        emit(STORIES);
        return true;
      }
      if (js === IN_STORY_VIEWER_JS) return inViewer;
      if (js === NEXT_REEL_JS) return false;
      return null;
    }),
    onMessage: (l: (m: HookMessage) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return page;
}

function fakeApi(start: Partial<{ knownIds: string[]; kind: string }> = {}) {
  const submitted: any[] = [];
  const api = {
    startRefresh: vi.fn(async () =>
      start.kind
        ? ({ kind: start.kind, reason: "kill_switch" } as any)
        : {
            kind: "run" as const,
            runId: "run1",
            trigger: "open",
            budget: { maxMs: 240_000, maxPosts: 60, maxStoryFrames: 40 },
            cursors: {},
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
  let clock = 0;
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
  test("reads the Following feed and stories, uploads images, and finishes", async () => {
    const page = fakePage();
    const { api, submitted } = fakeApi();
    const d = deps(page, api);
    const result = await runRefresh("open", d);
    expect(page.goto).toHaveBeenCalledWith("https://www.instagram.com/?variant=following");
    expect(result).toMatchObject({ outcome: "done", posts: 5, stories: 2, caughtUp: false });
    expect(submitted.filter((i) => i.format === "post")).toHaveLength(5);
    expect(submitted.filter((i) => i.format === "story")).toHaveLength(2);
    const reel = submitted.find((i) => i.facts.isReel);
    expect(reel.media[0]).toMatchObject({ kind: "video" });
    expect(reel.media[0].storageId).toBeUndefined();
    const image = submitted.find((i) => i.media[0]?.kind === "image");
    expect(image.media[0].storageId).toMatch(/^storage:/);
    expect(image.media[0]).not.toHaveProperty("upload");
    expect(api.submit.mock.calls[0][0].feedPage).toMatchObject({ variant: "following", hasNextPage: true });
    expect(api.finish).toHaveBeenCalledWith(expect.objectContaining({ runId: "run1", caughtUp: false }));
  });

  test("videos upload on Wi-Fi", async () => {
    const page = fakePage();
    const { api, submitted } = fakeApi();
    await runRefresh("open", deps(page, api, { onWifi: async () => true }));
    const reel = submitted.find((i) => i.facts.isReel);
    expect(reel.media[0].storageId).toMatch(/^storage:/);
  });

  test("stops at the first post an earlier refresh stored", async () => {
    const page = fakePage();
    const third = JSON.parse(FEED.type === "ig:response" ? FEED.body : "").data.xdt_api__v1__feed__timeline__connection.edges[2].node.media.pk;
    const { api, submitted } = fakeApi({ knownIds: ["instagram:" + third] });
    const result = await runRefresh("open", deps(page, api));
    expect(result).toMatchObject({ outcome: "done", posts: 2, caughtUp: true });
    expect(submitted.filter((i) => i.format === "post")).toHaveLength(2);
    expect(api.finish).toHaveBeenCalledWith(expect.objectContaining({ caughtUp: true }));
  });

  test("a challenge page aborts the refresh before anything is sent", async () => {
    const page = fakePage([{ type: "ig:location", href: "https://www.instagram.com/challenge/?next=/", title: "Instagram" }]);
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
    const result = await runRefresh("open", deps(page, api));
    expect(result.outcome).toBe("blocked");
    expect(page.goto).not.toHaveBeenCalled();
    expect(api.finish).not.toHaveBeenCalled();
  });
});
