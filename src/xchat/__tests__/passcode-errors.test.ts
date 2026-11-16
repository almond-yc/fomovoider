import { describe, expect, it } from "vitest";
import { passcodeErrorText } from "../passcode-errors";

describe("passcodeErrorText", () => {
  it("says how many tries X has left, and warns when few are left", () => {
    expect(passcodeErrorText({ kind: "wrongPasscode" })).toBe("Wrong passcode.");
    expect(passcodeErrorText({ kind: "wrongPasscode", guessesRemaining: 19 })).toBe("Wrong passcode. 19 tries left before X deletes your key backup.");
    expect(passcodeErrorText({ kind: "wrongPasscode", guessesRemaining: 3 })).toContain("Stop here");
  });

  it("explains the other setPasscode errors", () => {
    expect(passcodeErrorText({ kind: "notSetUp" })).toContain("Set one in the X app");
    expect(passcodeErrorText({ kind: "notConnected" })).toContain("Connect X first");
    expect(passcodeErrorText({ kind: "failed", message: "Juicebox error: timeout" })).toBe("Juicebox error: timeout");
  });
});
