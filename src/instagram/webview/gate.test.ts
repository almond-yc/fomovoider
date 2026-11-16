import { describe, expect, test } from "vitest";
import { allowNavigation } from "./gate";

const top = (url: string) => allowNavigation({ url, isTopFrame: true });
const frame = (url: string) => allowNavigation({ url, isTopFrame: false });

describe("allowNavigation", () => {
  test("keeps the top frame on www.instagram.com", () => {
    expect(top("about:blank")).toBe(true);
    expect(top("https://www.instagram.com/")).toBe(true);
    expect(top("https://www.instagram.com/?variant=following")).toBe(true);
    expect(top("https://www.instagram.com/direct/inbox/")).toBe(true);
    expect(top("https://www.instagram.com/accounts/login/")).toBe(true);
  });

  test("refuses app schemes in any frame", () => {
    for (const url of [
      "instagram://user?username=someone",
      "instagram://direct-inbox",
      "itms-appss://apps.apple.com/app/instagram/id389801252",
      "itms-apps://itunes.apple.com/app/id389801252",
      "intent://instagram.com/#Intent;scheme=https;package=com.instagram.android;end",
      "fb://profile",
      "javascript:alert(1)",
    ]) {
      expect(top(url)).toBe(false);
      expect(frame(url)).toBe(false);
    }
  });

  test("refuses top-frame hosts that hand off to other apps (universal links)", () => {
    for (const url of [
      "https://instagram.com/direct/inbox/",
      "https://l.instagram.com/?u=https%3A%2F%2Fexample.com",
      "https://help.instagram.com/",
      "https://www.facebook.com/login",
      "https://apps.apple.com/app/instagram/id389801252",
      "https://www.threads.net/@someone",
      "http://www.instagram.com/",
      "https://www.instagram.com.evil.example/",
      "not a url",
    ]) {
      expect(top(url)).toBe(false);
    }
  });

  test("treats a navigation without frame info as top frame", () => {
    expect(allowNavigation({ url: "https://www.instagram.com/" })).toBe(true);
    expect(allowNavigation({ url: "https://instagram.com/" })).toBe(false);
  });

  test("lets frames load https pages only", () => {
    expect(frame("https://www.google.com/recaptcha/api2/anchor")).toBe(true);
    expect(frame("https://www.facebook.com/instagram/login_sync/")).toBe(true);
    expect(frame("about:srcdoc")).toBe(true);
    expect(frame("http://example.com/")).toBe(false);
  });
});
