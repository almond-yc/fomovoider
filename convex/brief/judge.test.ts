// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModel } from "@langchain/core/testing";
import { HumanMessage, ToolMessage } from "langchain";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { judge, type JudgeInput } from "./judge";
import { ffmpegBinary, prepareMedia } from "./media";
import { MAX_IMAGES_PER_POST } from "./prompt";

// Media fixtures, made with ffmpeg so the repo carries no binaries: a
// 1600x900 PNG, a 1 s animated GIF and a 3 s MP4 with a poster.
const dir = mkdtempSync(join(tmpdir(), "brief-fixtures-"));
const files: Record<string, string> = {
  "https://cdn.test/photo.png": join(dir, "photo.png"),
  "https://cdn.test/loop.gif": join(dir, "loop.gif"),
  "https://cdn.test/clip.mp4": join(dir, "clip.mp4"),
  "https://cdn.test/poster.jpg": join(dir, "poster.jpg"),
};

beforeAll(async () => {
  const bin = await ffmpegBinary();
  const ff = (...args: string[]) => execFileSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  ff("-f", "lavfi", "-i", "testsrc=size=1600x900", "-frames:v", "1", files["https://cdn.test/photo.png"]);
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", files["https://cdn.test/loop.gif"]);
  ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=3", "-pix_fmt", "yuv420p", files["https://cdn.test/clip.mp4"]);
  ff("-f", "lavfi", "-i", "color=c=red:size=640x360", "-frames:v", "1", files["https://cdn.test/poster.jpg"]);
}, 60_000);

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const file = files[url];
    return file ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
  });
});

const author = { handle: "maya", displayName: "Maya" };

function input(media: JudgeInput["post"]["media"], quoted?: JudgeInput["post"]["quoted"]): JudgeInput {
  return {
    post: { platform: "instagram", author, text: "Moved to Lisbon!", createdAt: Date.parse("2026-11-16T08:00:00Z"), media, quoted, facts: { sponsored: false, suggested: true, isReel: false } },
    slopDescription: "Gym selfies and crypto",
  };
}

const image = { kind: "image" as const, url: "https://cdn.test/photo.png" };
const gif = { kind: "gif" as const, url: "https://cdn.test/loop.gif" };
const video = { kind: "video" as const, url: "https://cdn.test/clip.mp4", previewUrl: "https://cdn.test/poster.jpg" };

const verdict = {
  isSlop: false,
  slopTags: [],
  matchesPreferences: true,
  include: true,
  priority: 0.9,
  reason: "Maya moved to Lisbon",
  media: { attach: true, keepIndices: [0, 2, 7, 0], why: "The photo shows the new place" },
};

function images(message: HumanMessage | ToolMessage) {
  return message.contentBlocks.filter((b) => b.type === "image");
}

function labels(message: HumanMessage) {
  return message.contentBlocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
}

describe("prepareMedia", () => {
  test("downscales images, takes 3 GIF frames and a video's poster plus 4 keyframes", async () => {
    const prepared = await prepareMedia({ media: [image, gif, video] }, { maxImages: 20 });
    try {
      expect(prepared.media.map((m) => m.frames.length)).toEqual([1, 3, 5]);
      expect(prepared.media[2].frames.map((f) => f.label)).toEqual([
        "media[2] poster",
        "media[2] keyframe at 0.4s",
        "media[2] keyframe at 1.1s",
        "media[2] keyframe at 1.9s",
        "media[2] keyframe at 2.6s",
      ]);
      expect(prepared.media[2].durationSec).toBeCloseTo(3, 0);
      const jpeg = Buffer.from(prepared.media[0].frames[0].data, "base64");
      expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
      // SOF0 holds height then width; 1600x900 comes down to 1024x576.
      const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
      expect([jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5)]).toEqual([1024, 576]);
    } finally {
      await prepared.cleanup();
    }
  }, 60_000);

  test("sends at most 8 images per post, quoted media last, and notes what it couldn't load", async () => {
    const prepared = await prepareMedia({
      media: [image, { kind: "image", url: "https://cdn.test/gone.png" }, video],
      quoted: { media: [gif, image] },
    });
    try {
      expect(prepared.media.map((m) => [m.ref, m.frames.length])).toEqual([
        ["m0", 1],
        ["m1", 0],
        ["m2", 5],
        ["q0", 2],
        ["q1", 0],
      ]);
      expect(prepared.media[1].note).toContain("HTTP 404");
      expect(prepared.media[4].note).toContain(`limit of ${MAX_IMAGES_PER_POST}`);
    } finally {
      await prepared.cleanup();
    }
  }, 60_000);
});

describe("judge", () => {
  test("shows the model the post's text and frames, runs inspect_video, and returns a sanitized verdict", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "inspect_video", args: { ref: "m2", startSec: 1, endSec: 2, count: 2 } }])
      .respondWithTools([{ name: "submit_verdict", args: verdict }]);

    const result = await judge(input([image, gif, video]), model);

    expect(model.callCount).toBe(2);
    const [first, second] = model.calls;
    const system = first.messages[0];
    expect(system.text).toContain("engagement_bait");
    expect(system.text).toContain("Gym selfies and crypto");
    const human = first.messages.find((m): m is HumanMessage => HumanMessage.isInstance(m))!;
    expect(labels(human)[0]).toContain("Moved to Lisbon!");
    expect(labels(human)[0]).toContain("suggested=true");
    // 1 image + 3 GIF frames + poster and 3 keyframes: capped at 8.
    expect(images(human)).toHaveLength(MAX_IMAGES_PER_POST);
    expect(images(human).every((b) => b.type === "image" && b.mimeType === "image/jpeg" && (b.data as string).length > 100)).toBe(true);
    expect(labels(human)).toEqual(expect.arrayContaining(["media[1] (GIF) at 0.2s", "media[2] poster"]));

    const tool = second.messages.find((m): m is ToolMessage => ToolMessage.isInstance(m))!;
    expect(tool.name).toBe("inspect_video");
    expect(images(tool)).toHaveLength(2);

    expect(result.verdict).toEqual({ ...verdict, media: { ...verdict.media, keepIndices: [0, 2] } });
    expect(result.framesSent).toBe(MAX_IMAGES_PER_POST);
    expect(result.usage.modelCalls).toBe(2);
  }, 60_000);

  test("includes quoted-post media and an empty media list when the agent drops it", async () => {
    const model = fakeModel().respondWithTools([
      { name: "submit_verdict", args: { ...verdict, include: false, isSlop: true, slopTags: ["recycled"], media: { attach: true, keepIndices: [3], why: "" } } },
    ]);
    const result = await judge(input([], { author, text: "Original", media: [image] }), model);
    const human = model.calls[0].messages.find((m): m is HumanMessage => HumanMessage.isInstance(m))!;
    expect(images(human)).toHaveLength(1);
    expect(labels(human)).toContain("quoted media[0]");
    expect(result.verdict.media).toEqual({ attach: false, keepIndices: [], why: "" });
  }, 60_000);

  test("passes model errors through so the pool can retry", async () => {
    const model = fakeModel().respond(new Error("429 Too Many Requests"));
    await expect(judge(input([]), model)).rejects.toThrow("429");
  });
});
