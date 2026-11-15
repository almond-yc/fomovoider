import assert from "node:assert/strict";
import { test } from "node:test";
import { isDenied, checkTripwire, Tripwire } from "./guard.ts";
import { chromeText, parseAge, parseHeader, readFeedScreen, readProfile, readStoryFrame, readStoryTray } from "./parse.ts";
import { parseSource } from "./tree.ts";

// Synthetic screens shaped like Instagram iOS's accessibility tree; no real
// account data.
const el = (type: string, attrs: Record<string, string | number>, children = "") =>
  `<XCUIElementType${type} ${Object.entries({ visible: "true", x: 0, y: 0, width: 390, height: 40, ...attrs })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>${children}</XCUIElementType${type}>`;

const feed = el("Application", { name: "Instagram", label: "Instagram" }, el("Window", {},
  el("CollectionView", { name: "main-feed", height: 844 },
    el("Cell", { name: "stories-tray", label: "Stories Tray", y: 97 },
      el("Cell", { name: "story-tray-cell-self", label: "Button, Your story, Unseen" }) +
      el("Cell", { name: "story-tray-cell-alice", label: "Button, alice's story, Seen" }) +
      el("Cell", { name: "story-tray-cell-bob", label: "Button, bob's story, Unseen" })) +
    el("Cell", { y: 224, height: 55 },
      el("Other", { name: "header-view", value: "Post by alice, taken at Café Tortoni, Buenos Aires, 3 hours ago", y: 224 })) +
    el("Cell", { name: "page-cell", y: 278, height: 400 },
      el("Image", { name: "media-cell", label: "Photo by alice", y: 278, height: 400 })) +
    el("Cell", { name: "action-cell", y: 678 }, el("Button", { name: "like-button", label: "Like" })) +
    el("Cell", { y: 720 }, el("StaticText", { label: "alice Dinner with friends &amp; family… more" })) +
    el("Cell", { y: 745 },
      el("Other", { name: "header-view", value: "Post by brand, Ad, 2 weeks ago", y: 745 },
        el("Button", { name: "follow-button", label: "Follow brand" })))) +
  el("Other", { name: "tab-bar-container" }, el("Button", { name: "mainfeed-tab", label: "Main feed" }))));

test("parseHeader reads author, location, age and labels", () => {
  assert.deepEqual(parseHeader("Post by bob, taken 1 hour ago, Suggested for you"), {
    handle: "bob", coAuthors: [], location: undefined, age: "1 hour ago", sponsored: false, suggested: true,
  });
  assert.equal(parseHeader("Post by a and b, taken at Plaza de Mayo, 1 day ago")?.location, "Plaza de Mayo");
  assert.deepEqual(parseHeader("Post by a and b, taken at Plaza de Mayo, 1 day ago")?.coAuthors, ["b"]);
  assert.equal(parseHeader("Post by brand, Ad, 2 weeks ago")?.sponsored, true);
});

test("parseAge", () => {
  const now = Date.UTC(2026, 10, 15);
  assert.equal(parseAge("2 days ago", now), now - 2 * 86400e3);
  assert.equal(parseAge("19h", now), now - 19 * 3600e3);
  assert.equal(parseAge("whenever", now), undefined);
});

test("readFeedScreen groups cells into posts", () => {
  const parts = readFeedScreen(parseSource(feed))!;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].header?.location, "Café Tortoni, Buenos Aires");
  assert.equal(parts[0].followsAuthor, true);
  assert.equal(parts[0].media?.label, "Photo by alice");
  assert.equal(parts[0].caption, "Dinner with friends & family…");
  assert.equal(parts[1].header?.sponsored, true);
  assert.equal(parts[1].followsAuthor, false);
});

test("readStoryTray keeps order and seen state, without the user's own story", () => {
  assert.deepEqual(
    readStoryTray(parseSource(feed)).map(({ handle, seen, position }) => ({ handle, seen, position })),
    [{ handle: "alice", seen: true, position: 1 }, { handle: "bob", seen: false, position: 2 }],
  );
});

test("readStoryFrame and readProfile", () => {
  const story = el("Other", { name: "story-fullscreen-overlay-view", y: 47, height: 797 },
    el("Button", { name: "story-header", label: "bob's story.", y: 63, height: 20 }) +
    el("StaticText", { label: "5 hours ago", y: 63 }) +
    el("Button", { label: "Golden Gate Park", y: 300, height: 40 }) +
    el("Button", { name: "story-dismiss-button", label: "Close stories to return to feed", y: 69 }));
  const frame = readStoryFrame(parseSource(story))!;
  assert.equal(frame.handle, "bob");
  assert.equal(frame.age, "5 hours ago");
  assert.deepEqual(frame.stickers, ["Golden Gate Park"]);
  const profile = el("Button", { name: "user-switch-title-button", label: "me_handle" }) +
    el("Other", { name: "Me Name", label: "Me Name", x: 123, y: 120 });
  assert.deepEqual(readProfile(parseSource(profile)), { handle: "me_handle", displayName: "Me Name" });
});

test("guard: deny-list and tripwires ignore feed content", () => {
  for (const label of ["Like", "Follow brand", "Send", "Save", "Comment", "Share profile", "Log out"]) {
    assert.equal(isDenied(label), true, label);
  }
  assert.equal(isDenied("Main feed"), false);
  assert.equal(isDenied("Button, bob's story, Unseen"), false);
  const withCaption = feed.replace("Dinner with friends", "please try again later");
  assert.doesNotThrow(() => checkTripwire(chromeText(parseSource(withCaption))));
  assert.throws(() => checkTripwire("We suspect automated behavior on your account"), Tripwire);
  assert.throws(() => checkTripwire("Help us confirm it's you"), (e: Tripwire) => e.kind === "challenge");
});
