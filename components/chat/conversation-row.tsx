import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { conversationTitle, relativeTime, unavailableText } from '@/src/chat/format';
import type { ChatConversation } from '@/src/chat/types';
import { Lock } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { PersonAvatar } from './person-avatar';
import { PlatformBadge } from '@/components/platform-badge';

function preview(conversation: ChatConversation): string {
  const last = conversation.lastMessage;
  if (!last) return '';
  const text = last.text || (last.media.length ? (last.media[0]!.kind === 'video' ? 'Video' : 'Photo') : '');
  return last.isMine ? `You: ${text}` : text;
}

export function ConversationRow({
  conversation,
  now,
  onPress,
}: {
  conversation: ChatConversation;
  now: number;
  onPress?: () => void;
}) {
  const title = conversationTitle(conversation);
  const unread = (conversation.unreadCount ?? 0) > 0;
  const { unavailable } = conversation;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={unread ? `${title}, unread` : title}
      className="flex-row items-center gap-3 px-5 py-3.5 active:bg-accent">
      <View>
        <PersonAvatar person={conversation.participants[0]} name={title} className="size-11" />
        <View className="absolute -bottom-1 -right-1 rounded-[6px] border-2 border-background">
          <PlatformBadge platform={conversation.platform} />
        </View>
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text className={cn('flex-1 text-[15px]', unread ? 'font-sans-semibold' : 'font-sans-medium')} numberOfLines={1}>
            {title}
          </Text>
          <Text className="text-xs text-muted-foreground">{relativeTime(conversation.updatedAt, now)}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          {unavailable ? (
            <View className="flex-1 flex-row items-center gap-1.5">
              <Icon as={Lock} size={12} className="text-muted-foreground" />
              <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                {unavailableText(unavailable.reason, conversation.platform)}
              </Text>
            </View>
          ) : (
            <Text
              className={cn('flex-1 text-sm', unread ? 'text-foreground' : 'text-muted-foreground')}
              numberOfLines={1}>
              {preview(conversation)}
            </Text>
          )}
          {unread ? <View accessibilityLabel="Unread" className="size-2 rounded-full bg-foreground" /> : null}
        </View>
      </View>
    </Pressable>
  );
}
