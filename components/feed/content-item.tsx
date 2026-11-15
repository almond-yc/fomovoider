import { PlatformBadge, platformName } from '@/components/platform-badge';
// avatar hidden for now, per Alex
// import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Text } from '@/components/ui/text';
import { openBrowserAsync } from 'expo-web-browser';
import { Pressable, View } from 'react-native';

import { ContentMedia } from './content-media';
import type { FeedPost } from './types';

export function ContentItem({ post, title }: { post: FeedPost; title?: string }) {
  const { author } = post;

  return (
    <View className="flex-row gap-3 px-5 py-5">
      {/* avatar hidden for now, per Alex
      <Avatar alt={author.displayName}>
        {author.avatarUrl ? <AvatarImage source={{ uri: author.avatarUrl }} /> : null}
        <AvatarFallback>
          <Text className="text-xs text-muted-foreground">{author.displayName.slice(0, 1)}</Text>
        </AvatarFallback>
      </Avatar>
      */}
      <View className="flex-1 gap-2">
        <Text className="text-sm" numberOfLines={1}>
          <Text className="font-sans-semibold text-sm">{author.displayName}</Text>
          <Text className="text-sm text-muted-foreground"> @{author.handle}</Text>
        </Text>
        {title ? <Text className="font-title text-lg leading-6">{title}</Text> : null}
        {post.text ? <Text className="text-[15px] leading-[22px]">{post.text}</Text> : null}
        {post.media.map((m) => (
          <ContentMedia key={m.url} media={m} />
        ))}
        <Pressable
          onPress={() => openBrowserAsync(post.permalink)}
          hitSlop={15}
          accessibilityRole="link"
          accessibilityLabel={`View original on ${platformName(post.platform)}`}
          className="self-start">
          <PlatformBadge platform={post.platform} />
        </Pressable>
      </View>
    </View>
  );
}
