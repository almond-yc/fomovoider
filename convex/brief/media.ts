"use node";

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { MAX_IMAGES_PER_POST } from "./prompt";

// Turns a post's media into the images the judge looks at: images
// downscaled, a GIF as 3 frames, a video as its poster plus 4 keyframes,
// quoted-post media after the post's own, at most MAX_IMAGES_PER_POST in all.
// Videos and GIFs stay on disk so inspect_video can pull more frames.

export const MAX_EDGE = 1024;
export const GIF_FRAMES = 3;
export const VIDEO_KEYFRAMES = 4;
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type MediaInput = {
  kind: "image" | "video" | "gif";
  url: string;
  previewUrl?: string;
  altText?: string;
  durationSec?: number;
};

export type Frame = { mimeType: "image/jpeg"; data: string; label: string };

export type PreparedMedia = {
  // "m0" is the post's media[0], "q0" the quoted post's media[0].
  ref: string;
  source: "post" | "quoted";
  index: number;
  kind: MediaInput["kind"];
  altText?: string;
  frames: Frame[];
  durationSec?: number;
  // Set for videos and GIFs that downloaded; inspect_video reads it.
  file?: string;
  note?: string;
};

export type PreparedPost = {
  media: PreparedMedia[];
  dir: string;
  cleanup: () => Promise<void>;
};

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

let binary: Promise<string> | undefined;

// Convex unpacks external packages without the executable bit, so the
// binary is copied to /tmp and made executable once per instance when needed.
export function ffmpegBinary() {
  binary ??= (async () => {
    const src = ffmpegPath as unknown as string | null;
    if (!src) throw new Error("ffmpeg-static has no binary for this platform");
    try {
      await access(src, constants.X_OK);
      return src;
    } catch {
      const copy = join(tmpdir(), `ffmpeg-${process.pid}`);
      await copyFile(src, copy);
      await chmod(copy, 0o755);
      return copy;
    }
  })();
  return binary;
}

async function runFfmpeg(args: string[]) {
  const bin = await ffmpegBinary();
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-nostdin", ...args]);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function ffmpeg(args: string[]) {
  const { code, stderr } = await runFfmpeg(["-y", ...args]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`);
}

const SCALE = `scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease`;

// Duration in seconds, read from ffmpeg's banner (no ffprobe in ffmpeg-static).
export async function probeDuration(file: string) {
  const { stderr } = await runFfmpeg(["-i", file]);
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return seconds > 0 ? seconds : undefined;
}

async function toJpeg(input: string, output: string, atSec?: number) {
  await ffmpeg([
    ...(atSec === undefined ? [] : ["-ss", atSec.toFixed(2)]),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    SCALE,
    "-q:v",
    "5",
    output,
  ]);
  return (await readFile(output)).toString("base64");
}

// count frames spread evenly between start and end (seconds), each one from
// the middle of its slice so the first isn't a black lead-in.
export function frameTimes(count: number, start: number, end: number) {
  const span = Math.max(0, end - start);
  return Array.from({ length: count }, (_, i) => start + (span * (i + 0.5)) / count);
}

export async function extractFrames(
  file: string,
  dir: string,
  opts: { count: number; start: number; end: number; label: string },
): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const [i, t] of frameTimes(opts.count, opts.start, opts.end).entries()) {
    const out = join(dir, `${crypto.randomUUID()}.jpg`);
    try {
      frames.push({ mimeType: "image/jpeg", data: await toJpeg(file, out, t), label: `${opts.label} at ${t.toFixed(1)}s` });
    } catch {
      // A seek past a short clip's last frame yields nothing; keep the rest.
    }
    if (frames.length === 0 && i === opts.count - 1) {
      frames.push({ mimeType: "image/jpeg", data: await toJpeg(file, out), label: `${opts.label} first frame` });
    }
  }
  return frames;
}

async function download(fetchFn: Fetch, url: string, file: string) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  await writeFile(file, bytes);
}

function wanted(kind: MediaInput["kind"]) {
  return kind === "image" ? 1 : kind === "gif" ? GIF_FRAMES : 1 + VIDEO_KEYFRAMES;
}

export async function prepareMedia(
  post: { media: MediaInput[]; quoted?: { media: MediaInput[] } },
  opts: { fetch?: Fetch; maxImages?: number } = {},
): Promise<PreparedPost> {
  const fetchFn = opts.fetch ?? (fetch as Fetch);
  let budget = opts.maxImages ?? MAX_IMAGES_PER_POST;
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const all = [
    ...post.media.map((m, index) => ({ m, index, source: "post" as const })),
    ...(post.quoted?.media ?? []).map((m, index) => ({ m, index, source: "quoted" as const })),
  ];
  const media: PreparedMedia[] = [];
  for (const { m, index, source } of all) {
    const ref = `${source === "post" ? "m" : "q"}${index}`;
    const label = source === "post" ? `media[${index}]` : `quoted media[${index}]`;
    const item: PreparedMedia = { ref, source, index, kind: m.kind, altText: m.altText, frames: [] };
    media.push(item);
    if (budget <= 0) {
      item.note = `not shown (limit of ${MAX_IMAGES_PER_POST} images per post)`;
      continue;
    }
    const take = Math.min(budget, wanted(m.kind));
    try {
      if (m.kind === "image") {
        const src = join(dir, `${ref}.src`);
        await download(fetchFn, m.url, src);
        item.frames.push({ mimeType: "image/jpeg", data: await toJpeg(src, join(dir, `${ref}.jpg`)), label });
      } else {
        const src = join(dir, `${ref}.src`);
        await download(fetchFn, m.url, src);
        item.file = src;
        item.durationSec = (await probeDuration(src)) ?? m.durationSec;
        let frameCount = take;
        if (m.kind === "video") {
          let poster: Frame | undefined;
          if (m.previewUrl) {
            try {
              const p = join(dir, `${ref}.poster`);
              await download(fetchFn, m.previewUrl, p);
              poster = { mimeType: "image/jpeg", data: await toJpeg(p, join(dir, `${ref}.poster.jpg`)), label: `${label} poster` };
            } catch {
              // Fall back to the first frame below.
            }
          }
          poster ??= { mimeType: "image/jpeg", data: await toJpeg(src, join(dir, `${ref}.first.jpg`)), label: `${label} first frame` };
          item.frames.push(poster);
          frameCount = take - 1;
        }
        if (frameCount > 0) {
          item.frames.push(
            ...(await extractFrames(src, dir, {
              count: frameCount,
              start: 0,
              end: item.durationSec ?? 1,
              label: m.kind === "gif" ? `${label} (GIF)` : `${label} keyframe`,
            })),
          );
        }
      }
    } catch (error) {
      item.note = `could not be loaded (${error instanceof Error ? error.message : String(error)})`;
    }
    budget -= item.frames.length;
  }
  return { media, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
