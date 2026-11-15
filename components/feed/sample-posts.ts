import type { FeedPost } from './types';

export const samplePosts: (FeedPost & { id: string })[] = [
  {
    id: 'x:1',
    platform: 'x',
    createdAt: 1794765600000,
    author: { id: 'x:anaruiz', platform: 'x', handle: 'anaruiz', displayName: 'Ana Ruiz', avatarUrl: 'https://i.pravatar.cc/96?img=12' },
    title: 'Sunrise on the ridge',
    extracted: { place: { name: 'Mount Tamalpais' } },
    text: 'Finished the trail before sunrise. Worth the 4am alarm.',
    media: [{ kind: 'image', url: 'https://picsum.photos/seed/fomovoider-trail/1200/900', width: 1200, height: 900 }],
    permalink: 'https://x.com',
  },
  {
    id: 'instagram:2',
    platform: 'instagram',
    createdAt: 1794762000000,
    author: { id: 'instagram:m.chen', platform: 'instagram', handle: 'm.chen', displayName: 'Mei Chen', avatarUrl: 'https://i.pravatar.cc/96?img=32' },
    text: 'No title on this one, just a thought: the best feeds end.',
    media: [],
    permalink: 'https://instagram.com',
  },
  {
    id: 'x:3',
    platform: 'x',
    createdAt: 1794758400000,
    author: { id: 'x:planet', platform: 'x', handle: 'planet', displayName: 'Planet' },
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
    id: 'web:4',
    platform: 'web',
    createdAt: 1794754800000,
    author: { id: 'web:blender', platform: 'web', handle: 'blender', displayName: 'Blender Studio', avatarUrl: 'https://i.pravatar.cc/96?img=48' },
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
