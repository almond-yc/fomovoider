import type { FeedPost } from './types';

export const samplePosts: (FeedPost & { id: string; title?: string })[] = [
  {
    id: 'x:1',
    author: { handle: 'anaruiz', displayName: 'Ana Ruiz', avatarUrl: 'https://i.pravatar.cc/96?img=12' },
    title: 'Sunrise on the ridge',
    text: 'Finished the trail before sunrise. Worth the 4am alarm.',
    media: [{ kind: 'image', url: 'https://picsum.photos/seed/fomovoider-trail/1200/900', width: 1200, height: 900 }],
    permalink: 'https://x.com',
  },
  {
    id: 'instagram:2',
    author: { handle: 'm.chen', displayName: 'Mei Chen', avatarUrl: 'https://i.pravatar.cc/96?img=32' },
    text: 'No title on this one, just a thought: the best feeds end.',
    media: [],
    permalink: 'https://instagram.com',
  },
  {
    id: 'x:3',
    author: { handle: 'planet', displayName: 'Planet' },
    text: 'Earth, rotating.',
    media: [
      {
        kind: 'gif',
        url: 'https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif',
        width: 400,
        height: 400,
      },
    ],
    permalink: 'https://commons.wikimedia.org/wiki/File:Rotating_earth_(large).gif',
  },
  {
    id: 'x:4',
    author: { handle: 'blender', displayName: 'Blender Studio', avatarUrl: 'https://i.pravatar.cc/96?img=48' },
    text: 'Big Buck Bunny, still a classic.',
    media: [
      {
        kind: 'video',
        url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        width: 640,
        height: 360,
      },
    ],
    permalink: 'https://peach.blender.org',
  },
];
