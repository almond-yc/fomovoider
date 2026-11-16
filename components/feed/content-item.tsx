import { PlatformBadge, platformName } from '@/components/platform-badge';
// avatar hidden for now, per Alex
// import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openBrowserAsync } from 'expo-web-browser';
import { Bookmark, MapPin } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { ContentMedia } from './content-media';
import type { FeedPost } from './types';

export function ContentItem({
  post,
  title = post.title,
  saved = false,
  onOpen,
}: {
  post: FeedPost;
  title?: string;
  saved?: boolean;
  onOpen?: () => void;
}) {
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
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-sm" numberOfLines={1}>
            <Text className="font-sans-semibold text-sm">{author.displayName}</Text>
            {author.displayName === author.handle ? null : (
              <Text className="text-sm text-muted-foreground"> @{author.handle}</Text>
            )}
            {post.format === 'story' ? <Text className="text-sm text-muted-foreground"> · Story</Text> : null}
          </Text>
          {saved ? (
            <Icon as={Bookmark} size={14} className="text-muted-foreground" accessibilityLabel="Saved" />
          ) : null}
          <Pressable
            onPress={() => {
              onOpen?.();
              void openBrowserAsync(post.permalink);
            }}
            hitSlop={15}
            accessibilityRole="link"
            accessibilityLabel={`View original on ${platformName(post.platform)}`}>
            <PlatformBadge platform={post.platform} monochrome />
          </Pressable>
        </View>
        {title ? <Text className="font-title text-lg leading-6">{title}</Text> : null}
        {post.text ? <Text className="text-[15px] leading-[22px]">{post.text}</Text> : null}
        {post.media.map((m) => (
          <ContentMedia key={m.url} media={m} />
        ))}
        {post.extracted?.place ? (
          <View className="flex-row items-center gap-1">
            <Icon as={MapPin} size={12} className="text-muted-foreground" />
            <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
              {post.extracted.place.name}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
