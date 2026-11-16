// Scripts the host runs inside the instagram.com page (PageControl.evaluate).
// Navigation is limited to loading the home page (story tray) and the
// Following feed and scrolling it. Stories are read with one query per few
// reels instead of opening the viewer, which would send "seen" receipts.
// Nothing here likes, follows, replies or types.

export const FOLLOWING_URL = "https://www.instagram.com/?variant=following";
export const HOME_URL = "https://www.instagram.com/";

// Scrolls down about one screen in a few uneven steps, like a thumb flick.
export const scrollFeedJs = (fraction: number) => `
  const target = Math.round(window.innerHeight * ${fraction});
  const steps = 3 + Math.floor(Math.random() * 3);
  let done = 0;
  for (let i = 0; i < steps; i++) {
    const step = i === steps - 1 ? target - done : Math.round((target / steps) * (0.7 + Math.random() * 0.6));
    window.scrollBy({ top: step, behavior: "smooth" });
    done += step;
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 220));
  }
  return { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight };
`;

// Asks the capture hook (hook.ts, exposed under the session's key) to send
// one story gallery query; its response arrives like any captured one.
export const storyQueryJs = (key: string, reelIds: string[], initialReelId: string, first: number) =>
  `return await window[${JSON.stringify(key)}].stories(${JSON.stringify(reelIds)}, ${JSON.stringify(initialReelId)}, ${first});`;
