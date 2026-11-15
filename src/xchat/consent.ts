// The consent shown once before the first passcode entry, and again from
// Settings. Bump CONSENT_VERSION in passcode-store.ts when the meaning changes.
export const CONSENT_TITLE = "Read your encrypted X chats in Fomovoider";

export const CONSENT_POINTS = [
  "X Chat is end-to-end encrypted. To show those chats here, Fomovoider needs your X Chat passcode on this phone.",
  "Your passcode is used only on this phone, by X's own encryption software, to unlock your chat keys. It is never sent to Fomovoider's servers, and we can't see it.",
  "After you unlock, Fomovoider saves your passcode in this phone's secure storage (iOS Keychain or Android Keystore), protected by Face ID or your fingerprint, so next time you only need Face ID. It never leaves this phone and isn't included in backups. You can turn this off in Settings, and then you'll type the passcode after every restart.",
  "Your keys and decrypted messages stay in this phone's memory while the app is open. Our servers only store the encrypted copies X already sends.",
  "Because of that, encrypted chats can't be previewed in notifications, sorted by importance, or synced while the app is closed.",
  "Anyone who has your passcode can read your X chats. Never share it with anyone, including us. Fomovoider will never ask for it by email, chat or support.",
  "X allows 20 wrong tries. After that, X deletes your key backup and you may lose access to old encrypted messages on new devices.",
  "You can lock X Chat or disconnect X at any time in Settings.",
];

export const CONSENT_CHECKBOX =
  "I understand that Fomovoider will use my X Chat passcode on this phone, and keep it there behind Face ID or my fingerprint, to read and send my encrypted X messages.";
