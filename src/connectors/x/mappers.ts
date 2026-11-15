import type { Conversation, Id, Media, Message, Person, Post } from "../types";
import type { XDmEvent, XIncludes, XMedia, XTweet, XUrlEntity, XUser } from "./api-types";

export const xId = (id: string): Id => `x:${id}`;

export function compareXIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

export function mapPerson(user: XUser): Person {
  return {
    id: xId(user.id),
    platform: "x",
    handle: user.username,
    displayName: user.name,
    ...(user.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
    profileUrl: `https://x.com/${user.username}`,
  };
}

function unknownPerson(id: string | undefined): Person {
  return { id: xId(id ?? "unknown"), platform: "x", handle: "", displayName: "" };
}

export function permalink(id: string, handle?: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function isMediaLink(url: XUrlEntity): boolean {
  if (url.media_key) return true;
  if (/^pic\.(x|twitter)\.com\//.test(url.display_url ?? "")) return true;
  return /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\/\d+$/.test(url.expanded_url ?? "");
}

function isLinkToPost(url: XUrlEntity, postId: string): boolean {
  return new RegExp(`^https?://(?:www\\.)?(?:x|twitter)\\.com/[^/]+/status/${postId}(?:[/?#].*)?$`).test(url.expanded_url ?? "");
}

export function cleanText(text: string, urls: XUrlEntity[] = [], drop: (url: XUrlEntity) => boolean = isMediaLink): string {
  let out = text;
  for (const url of urls) out = out.split(url.url).join(drop(url) ? "" : (url.expanded_url ?? url.url));
  out = out.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

export function mapMedia(media: XMedia): Media | null {
  const base = {
    ...(media.width ? { width: media.width } : {}),
    ...(media.height ? { height: media.height } : {}),
    ...(media.alt_text ? { altText: media.alt_text } : {}),
  };
  if (media.type === "photo") return media.url ? { kind: "image", url: media.url, ...base } : null;
  const best = (media.variants ?? [])
    .filter((v) => v.content_type === "video/mp4")
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
  const url = best?.url ?? media.url;
  if (!url) return null;
  return {
    kind: media.type === "animated_gif" ? "gif" : "video",
    url,
    ...(media.preview_image_url ? { previewUrl: media.preview_image_url } : {}),
    ...base,
    ...(media.type === "video" && media.duration_ms ? { durationSec: media.duration_ms / 1000 } : {}),
  };
}

export class XMapper {
  private readonly users: Map<string, XUser>;
  private readonly media: Map<string, XMedia>;
  private readonly tweets: Map<string, XTweet>;

  constructor(includes: XIncludes | undefined, extraUsers: XUser[] = []) {
    this.users = new Map([...extraUsers, ...(includes?.users ?? [])].map((u) => [u.id, u]));
    this.media = new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
    this.tweets = new Map((includes?.tweets ?? []).map((t) => [t.id, t]));
  }

  person(id: string | undefined): Person {
    const user = id ? this.users.get(id) : undefined;
    return user ? mapPerson(user) : unknownPerson(id);
  }

  mediaFor(keys: string[] | undefined): Media[] {
    return (keys ?? []).flatMap((key) => {
      const m = this.media.get(key);
      const mapped = m ? mapMedia(m) : null;
      return mapped ? [mapped] : [];
    });
  }

  post(tweet: XTweet, nested = false): Post {
    const reposted = tweet.referenced_tweets?.find((r) => r.type === "retweeted");
    const original = reposted ? this.tweets.get(reposted.id) : undefined;
    if (original) {
      return { ...this.post(original, nested), repostedBy: this.person(tweet.author_id), ...(tweet.created_at ? { createdAt: tweet.created_at } : {}) };
    }

    const author = this.person(tweet.author_id);
    const quotedRef = tweet.referenced_tweets?.find((r) => r.type === "quoted");
    const quotedTweet = quotedRef && !nested ? this.tweets.get(quotedRef.id) : undefined;
    const repliedRef = tweet.referenced_tweets?.find((r) => r.type === "replied_to");
    const urls = tweet.note_tweet?.entities?.urls ?? tweet.entities?.urls ?? [];
    let text = cleanText(tweet.note_tweet?.text ?? tweet.text, urls, (u) => isMediaLink(u) || (quotedRef !== undefined && isLinkToPost(u, quotedRef.id)));
    if (repliedRef) text = text.replace(/^(@\w+\s+)+/, "");

    const replyAuthor = tweet.in_reply_to_user_id && this.users.has(tweet.in_reply_to_user_id) ? this.person(tweet.in_reply_to_user_id) : undefined;
    return {
      id: xId(tweet.id),
      platform: "x",
      author,
      createdAt: tweet.created_at ?? "",
      text,
      media: this.mediaFor(tweet.attachments?.media_keys),
      permalink: permalink(tweet.id, author.handle || undefined),
      ...(quotedTweet ? { quoted: this.post(quotedTweet, true) } : {}),
      ...(repliedRef ? { replyTo: { id: xId(repliedRef.id), ...(replyAuthor ? { author: replyAuthor } : {}) } } : {}),
      raw: tweet,
    };
  }

  message(event: XDmEvent, meId: string, conversationId?: string): Message {
    return {
      id: xId(event.id),
      conversationId: xId(event.dm_conversation_id ?? conversationId ?? ""),
      sender: this.person(event.sender_id),
      isMine: event.sender_id === meId,
      sentAt: event.created_at ?? "",
      text: cleanText(event.text ?? "", event.entities?.urls),
      media: this.mediaFor(event.attachments?.media_keys),
      raw: event,
    };
  }

  conversations(events: XDmEvent[], meId: string): Conversation[] {
    const groups = new Map<string, { participants: Set<string>; last?: XDmEvent; newest?: XDmEvent }>();
    for (const event of events) {
      const id = event.dm_conversation_id;
      if (!id) continue;
      const group = groups.get(id) ?? { participants: new Set<string>() };
      if (/^\d+-\d+$/.test(id)) for (const p of id.split("-")) group.participants.add(p);
      for (const p of event.participant_ids ?? []) group.participants.add(p);
      if (event.sender_id) group.participants.add(event.sender_id);
      if (!group.newest || compareXIds(event.id, group.newest.id) > 0) group.newest = event;
      if (event.event_type === "MessageCreate" && (!group.last || compareXIds(event.id, group.last.id) > 0)) group.last = event;
      groups.set(id, group);
    }
    return [...groups.entries()]
      .map(([id, group]) => {
        const lastMessage = group.last ? this.message(group.last, meId, id) : undefined;
        const others = [...group.participants].filter((p) => p !== meId);
        const encrypted = /^\d+-\d+$/.test(id) && others.some((p) => this.users.get(p)?.receives_your_chat === "encrypted");
        return {
          id: xId(id),
          platform: "x",
          participants: others.map((p) => this.person(p)),
          ...(lastMessage ? { lastMessage } : {}),
          ...(encrypted ? { unavailable: { reason: "encrypted" } } : {}),
          updatedAt: lastMessage?.sentAt ?? group.newest?.created_at ?? "",
        } satisfies Conversation;
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
}
