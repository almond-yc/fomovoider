import { expect, test } from "vitest";
import { tripwireFor } from "./tripwire";

test("challenge, checkpoint and login pages trip; the feed and stories do not", () => {
  expect(tripwireFor("https://www.instagram.com/challenge/action/")?.kind).toBe("challenge");
  expect(tripwireFor("https://www.instagram.com/auth_platform/recaptcha/?apc=x")?.kind).toBe("challenge");
  expect(tripwireFor("https://www.instagram.com/accounts/suspended/")?.kind).toBe("suspicious");
  expect(tripwireFor("https://www.instagram.com/accounts/login/?next=%2F")?.kind).toBe("login");
  expect(tripwireFor("https://www.instagram.com/", "Try Again Later")?.kind).toBe("suspicious");
  expect(tripwireFor("https://www.instagram.com/?variant=following", "Instagram")).toBeNull();
  expect(tripwireFor("https://www.instagram.com/stories/someone/123/")).toBeNull();
  expect(tripwireFor("https://www.facebook.com/challenge/")).toBeNull();
});
