import { setTimeout as sleep } from "node:timers/promises";
import type { Wda } from "./wda.ts";

const rand = (min: number, max: number) => min + Math.random() * (max - min);

// A pause shaped like a person reading: mostly short, sometimes long.
export async function dwell(minMs = 1200, maxMs = 4000) {
  const skew = Math.random() ** 2;
  await sleep(minMs + skew * (maxMs - minMs));
}

// A vertical flick with real duration and a little horizontal wobble.
export async function scrollFeed(wda: Wda, size: { width: number; height: number }) {
  const x = size.width * rand(0.35, 0.65);
  const fromY = size.height * rand(0.68, 0.78);
  const distance = size.height * rand(0.5, 0.62);
  await wda.drag(x, fromY, x + rand(-12, 12), fromY - distance, rand(0.25, 0.6));
}

// Advance to the next story frame by tapping the right edge of the frame,
// in the middle band, away from the reply bar and the header.
export async function nextStoryFrame(wda: Wda, size: { width: number; height: number }) {
  await wda.tapPoint(size.width * rand(0.82, 0.93), size.height * rand(0.35, 0.6));
}

export { rand, sleep };
