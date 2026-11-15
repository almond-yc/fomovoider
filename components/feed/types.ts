import type { api } from '@/convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';

// A post as feed.page returns it: dates in epoch ms, media and avatar URLs
// already pointing at the stored copy when one exists.
export type FeedPagePost = FunctionReturnType<typeof api.feed.page>['page'][number];

// The fields ContentItem renders, so sample posts need not invent ids.
export type FeedPost = Pick<
  FeedPagePost,
  'platform' | 'author' | 'title' | 'createdAt' | 'text' | 'media' | 'permalink' | 'format' | 'extracted'
>;
export type FeedMedia = FeedPost['media'][number];
export type FeedPerson = FeedPost['author'];
