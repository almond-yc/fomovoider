import { USER_FIELDS } from "../endpoints";

export const CHAT_CONVERSATION_FIELDS = "id,type,created_at,updated_at,group_name,unread,last_read_event_id,newest_event_id";
export const CHAT_CONVERSATION_EXPANSIONS = "participant_ids,member_ids";
export const CHAT_USER_FIELDS = `${USER_FIELDS},receives_your_chat`;
export const CHAT_EVENT_FIELDS = "id,encoded_event,conversation_id,conversation_key_version,created_at,sender_id,previous_id";
export const PUBLIC_KEY_FIELDS = "public_key,public_key_version,signing_public_key,identity_public_key_signature,juicebox_config";
export const MAX_CHAT_EVENTS = 100;

export const chatPaths = {
  conversations: "/2/chat/conversations",
  events: (target: string) => `/2/chat/conversations/${encodeURIComponent(target)}/events`,
  messages: (target: string) => `/2/chat/conversations/${encodeURIComponent(target)}/messages`,
  publicKeys: (userId: string) => `/2/users/${encodeURIComponent(userId)}/public_keys`,
};
