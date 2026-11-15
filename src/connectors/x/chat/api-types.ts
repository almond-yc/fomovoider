import type { XUser } from "../api-types";

export interface XChatConversation {
  id: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  participant_ids?: string[];
  member_ids?: string[];
  group_name?: string;
  unread?: boolean;
  last_read_event_id?: string;
  newest_event_id?: string;
  is_muted?: boolean;
  is_archived?: boolean;
}

export interface XChatConversationsResponse {
  data?: XChatConversation[];
  includes?: { users?: XUser[] };
  meta?: { has_more?: boolean; next_token?: string; result_count?: number };
}

export interface XChatEvent {
  id: string;
  encoded_event: string;
  conversation_id?: string;
  conversation_key_version?: string;
  created_at?: string;
  sender_id?: string;
  previous_id?: string;
}

export interface XChatEventsResponse {
  data?: XChatEvent[];
  meta?: { conversation_key_events?: string[]; has_more?: boolean; next_token?: string; result_count?: number };
}

export interface XPublicKeyRecord {
  user_id?: string;
  public_key?: string;
  public_key_version?: string;
  signing_public_key?: string;
  identity_public_key_signature?: string;
  juicebox_config?: unknown;
}

export interface XPublicKeysResponse {
  data?: XPublicKeyRecord[];
}

export interface XChatSendResponse {
  data?: { encoded_message_event?: string };
}
