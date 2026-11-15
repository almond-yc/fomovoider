import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rect } from "./parse.ts";

// Crops a region (in screen points) out of a WDA screenshot and re-encodes it
// as a JPEG of at most 1080 px on its long side, using macOS's sips.
export function cropJpeg(png: Buffer, rect: Rect, screenWidthPt: number) {
  const scale = png.readUInt32BE(16) / screenWidthPt;
  const pxHeight = png.readUInt32BE(20);
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const w = Math.round(rect.width * scale);
  const h = Math.min(Math.round(rect.height * scale), pxHeight - y);
  const dir = mkdtempSync(join(tmpdir(), "ig-crop-"));
  try {
    const src = join(dir, "in.png");
    const cropped = join(dir, "crop.png");
    const out = join(dir, "out.jpg");
    writeFileSync(src, png);
    execFileSync("sips", ["-c", String(h), String(w), "--cropOffset", String(y), String(x), src, "--out", cropped], { stdio: "ignore" });
    execFileSync("sips", ["-Z", "1080", "-s", "format", "jpeg", "-s", "formatOptions", "80", cropped, "--out", out], { stdio: "ignore" });
    return { jpeg: readFileSync(out), width: Math.round(rect.width), height: Math.round(h / scale) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
