// What the passcode screen says for each api.x.chatNode.setPasscode error.
export type SetPasscodeError =
  | { kind: "wrongPasscode"; guessesRemaining?: number }
  | { kind: "notSetUp" }
  | { kind: "notConnected" }
  | { kind: "failed"; message: string };

export function passcodeErrorText(error: SetPasscodeError): string {
  switch (error.kind) {
    case "wrongPasscode":
      if (error.guessesRemaining === undefined) return "Wrong passcode.";
      return `Wrong passcode. ${error.guessesRemaining} tries left before X deletes your key backup.${error.guessesRemaining < 5 ? " Stop here and reset your passcode in the X app instead." : ""}`;
    case "notSetUp":
      return "This X account has no X Chat passcode yet. Set one in the X app first, then come back.";
    case "notConnected":
      return "Connect X first, then enter your X Chat passcode.";
    case "failed":
      return error.message;
  }
}
