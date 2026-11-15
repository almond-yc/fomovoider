export const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const API_BASE = "https://api.x.com";
export const TOKEN_PATH = "/2/oauth2/token";
export const REVOKE_PATH = "/2/oauth2/revoke";

export const SCOPES = ["tweet.read", "users.read", "tweet.write", "dm.read", "dm.write", "offline.access"];

export const MAX_RESULTS = 100;

export const POST_FIELDS = "created_at,conversation_id,referenced_tweets,attachments,entities,author_id,in_reply_to_user_id,note_tweet,article";
export const POST_EXPANSIONS = "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,in_reply_to_user_id";
export const MEDIA_FIELDS = "type,url,preview_image_url,alt_text,width,height,duration_ms,variants";
export const USER_FIELDS = "username,name,profile_image_url";
export const DM_EVENT_FIELDS = "id,event_type,dm_conversation_id,created_at,sender_id,participant_ids,attachments,text,entities";
export const DM_EXPANSIONS = "sender_id,participant_ids,attachments.media_keys";
export const DM_USER_FIELDS = `${USER_FIELDS},receives_your_chat`;

export const paths = {
  me: "/2/users/me",
  homeTimeline: (userId: string) => `/2/users/${encodeURIComponent(userId)}/timelines/reverse_chronological`,
  mentions: (userId: string) => `/2/users/${encodeURIComponent(userId)}/mentions`,
  dmEvents: "/2/dm_events",
  conversationEvents: (conversationId: string) => `/2/dm_conversations/${encodeURIComponent(conversationId)}/dm_events`,
  conversationMessages: (conversationId: string) => `/2/dm_conversations/${encodeURIComponent(conversationId)}/messages`,
  tweets: "/2/tweets",
};
