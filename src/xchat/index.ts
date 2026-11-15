// Client-side X Chat API for the app's Chats tab. See README.md.
export { XChatProvider, useOptionalXChat, useXChat, type XChatContextValue, type XChatError, type XChatStatus } from "./XChatProvider";
export { useXChatInbox, useXChatMessages } from "./hooks";
export { isLockedXChat, type InboxConversation, type InboxMessage } from "./inbox";

// The unlock flow (consent, passcode, Face ID). Push it from any locked row.
export const XCHAT_UNLOCK_HREF = "/x-chat/unlock";
export const XCHAT_SETTINGS_HREF = "/x-chat/settings";
