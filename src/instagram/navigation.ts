// Scripts the host runs inside the instagram.com page (PageControl.evaluate).
// Navigation is limited to what a person does to read: scroll the feed, open
// the story tray, skip to the next person's stories and close the viewer.
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

export const SCROLL_TOP_JS = `
  window.scrollTo({ top: 0, behavior: "smooth" });
  await new Promise((r) => setTimeout(r, 600));
  return Math.round(window.scrollY);
`;

function clickJs(find: string) {
  return `
  const el = (() => { ${find} })();
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * (0.35 + Math.random() * 0.3), y = r.top + r.height * (0.35 + Math.random() * 0.3);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }
  el.click();
  return true;
`;
}

// The first story in the tray at the top of the feed.
export const OPEN_STORY_TRAY_JS = clickJs(`
  const link = document.querySelector('a[href^="/stories/"]:not([href*="/highlights/"])');
  if (link) return link;
  const labelled = [...document.querySelectorAll('[role="button"][aria-label], button[aria-label]')]
    .find((b) => /story/i.test(b.getAttribute("aria-label") || "") && b.getBoundingClientRect().top < 300);
  if (labelled) return labelled;
  const ring = [...document.querySelectorAll('canvas')].find((c) => c.getBoundingClientRect().top < 300);
  return ring && (ring.closest('[role="button"], button, a') || ring);
`);

export const NEXT_REEL_JS = clickJs(`
  return [...document.querySelectorAll('[role="button"][aria-label], button[aria-label]')]
    .find((b) => /^next$/i.test(b.getAttribute("aria-label") || ""));
`);

export const CLOSE_STORIES_JS = `
  const close = [...document.querySelectorAll('[role="button"][aria-label], button[aria-label], svg[aria-label]')]
    .find((b) => /^close$/i.test(b.getAttribute("aria-label") || ""));
  if (close) { (close.closest('[role="button"], button') || close).dispatchEvent(new MouseEvent("click", { bubbles: true })); return "close"; }
  history.back();
  return "back";
`;

export const IN_STORY_VIEWER_JS = `return location.pathname.startsWith("/stories/");`;
