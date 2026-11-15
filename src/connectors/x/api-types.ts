export interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  receives_your_chat?: "encrypted" | "unencrypted" | "none" | (string & {});
}

export interface XMediaVariant {
  content_type: string;
  url: string;
  bit_rate?: number;
}

export interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif" | string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  variants?: XMediaVariant[];
}

export interface XUrlEntity {
  start?: number;
  end?: number;
  url: string;
  expanded_url?: string;
  display_url?: string;
  media_key?: string;
  title?: string;
}

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: "replied_to" | "quoted" | "retweeted"; id: string }[];
  attachments?: { media_keys?: string[] };
  entities?: {
    mentions?: { username: string; id?: string }[];
    urls?: XUrlEntity[];
  };
  note_tweet?: { text: string; entities?: { urls?: XUrlEntity[] } };
  article?: { title?: string };
}

export interface XIncludes {
  users?: XUser[];
  media?: XMedia[];
  tweets?: XTweet[];
}

export interface XMeta {
  result_count?: number;
  newest_id?: string;
  oldest_id?: string;
  next_token?: string;
}

export interface XListResponse<T> {
  data?: T[];
  includes?: XIncludes;
  meta?: XMeta;
}

export interface XDmEvent {
  id: string;
  event_type: "MessageCreate" | "ParticipantsJoin" | "ParticipantsLeave" | string;
  dm_conversation_id?: string;
  created_at?: string;
  sender_id?: string;
  participant_ids?: string[];
  text?: string;
  entities?: { urls?: XUrlEntity[] };
  attachments?: { media_keys?: string[]; card_ids?: string[] };
}
