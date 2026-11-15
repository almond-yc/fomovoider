export type FeedMedia = {
  kind: 'image' | 'gif' | 'video';
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  altText?: string;
};

export type FeedPerson = {
  handle: string;
  displayName: string;
  avatarUrl?: string;
};

export type FeedPost = {
  author: FeedPerson;
  text: string;
  media: FeedMedia[];
  permalink: string;
};
