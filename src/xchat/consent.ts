// The X Chat consent, shown before the passcode is first entered (onboarding
// or Settings). The final copy is also in convex/x/README.md, "Consent"; keep
// them identical, and bump CONSENT_VERSION in passcode-store.ts when the
// meaning changes.
export const CONSENT_TITLE = "Read your encrypted X chats in Fomovoider";

export const CONSENT_POINTS = [
  "X Chat is end-to-end encrypted. To show and send those chats in Fomovoider, we need your X Chat passcode once.",
  "We check the passcode with X and use it to unlock your X Chat keys. Fomovoider then stores those keys on its servers, encrypted, to read and send your X Chat messages. We don't store the passcode itself.",
  "Your X chats then sync in the background like your other messages, and the decrypted messages are kept in your Fomovoider inbox.",
  "Anyone who got those keys could read your X chats, past and future, and send messages as you. Fomovoider keeps them encrypted and never shows them to anyone, including you.",
  "X allows 20 wrong passcode tries. After that, X deletes your key backup and you may lose access to older encrypted messages. We only try a passcode when you enter it, never again on our own.",
  "You can remove the saved keys at any time in Settings, and they're deleted when you disconnect X. If you change your X Chat passcode or keys in the X app, you'll be asked for it again.",
];

export const CONSENT_CHECKBOX = "I agree that Fomovoider stores my X Chat keys on its servers to read and send my X Chat messages.";
