import { ContentMedia } from '@/components/feed/content-media';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { messageTime } from '@/src/chat/format';
import type { ChatMessage } from '@/src/chat/types';
import { CircleAlert } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

export type PendingMessage = {
  key: string;
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  sent?: Pick<ChatMessage, 'id' | 'text' | 'sentAt'>;
};

function Bubble({
  mine,
  faded,
  className,
  children,
}: {
  mine: boolean;
  faded?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <View
      className={cn(
        'max-w-[80%] gap-1.5 overflow-hidden rounded-2xl px-3.5 py-2',
        mine ? 'self-end rounded-br-md bg-primary' : 'self-start rounded-bl-md bg-muted',
        faded && 'opacity-60',
        className
      )}>
      {children}
    </View>
  );
}

export function MessageBubble({ message, showSender }: { message: ChatMessage; showSender?: boolean }) {
  const mine = message.isMine;
  const delivery = message.delivery?.status;
  return (
    <View className={cn('gap-1 px-4', mine ? 'items-end' : 'items-start')}>
      {showSender && !mine ? (
        <Text className="px-1 text-xs text-muted-foreground">{message.sender.displayName || `@${message.sender.handle}`}</Text>
      ) : null}
      <View className={cn('max-w-[80%] flex-row items-center gap-2', mine ? 'self-end' : 'self-start')}>
        {delivery === 'failed' ? <Icon as={CircleAlert} size={16} className="text-destructive" /> : null}
        <Bubble mine={mine} faded={delivery === 'pending'} className="max-w-full shrink">
        {message.media.map((m) => (
          <View key={m.url} className="w-60">
            <ContentMedia media={m} />
          </View>
        ))}
        {message.text ? (
          <Text className={cn('text-[15px] leading-[21px]', mine && 'text-primary-foreground')}>{message.text}</Text>
        ) : null}
        </Bubble>
      </View>
      {delivery === 'pending' ? (
        <Text className="px-1 text-[11px] text-muted-foreground">Sending…</Text>
      ) : delivery === 'failed' ? (
        <Text className="max-w-[85%] px-1 text-right text-[11px] text-destructive">
          {message.delivery?.error ? `Not delivered: ${message.delivery.error}` : 'Not delivered'}
        </Text>
      ) : (
        <Text className="px-1 text-[11px] text-muted-foreground">{messageTime(message.sentAt)}</Text>
      )}
    </View>
  );
}

export function PendingBubble({
  pending,
  onRetry,
  onDiscard,
}: {
  pending: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const failed = pending.status === 'failed';
  return (
    <View className="items-end gap-1 px-4">
      <Pressable
        disabled={!failed}
        onPress={onRetry}
        accessibilityRole={failed ? 'button' : undefined}
        accessibilityHint={failed ? 'Sends the message again' : undefined}
        className="max-w-[80%] flex-row items-center gap-2 self-end">
        {failed ? <Icon as={CircleAlert} size={16} className="text-destructive" /> : null}
        <Bubble mine faded={!failed}>
          <Text className="text-[15px] leading-[21px] text-primary-foreground">{pending.text}</Text>
        </Bubble>
      </Pressable>
      {failed ? (
        <View className="max-w-[85%] items-end gap-0.5 px-1">
          <Text className="text-right text-[11px] text-destructive">{pending.error}</Text>
          <View className="flex-row gap-3">
            <Pressable onPress={onRetry} hitSlop={6}>
              <Text className="font-sans-medium text-[11px] text-foreground">Tap to retry</Text>
            </Pressable>
            <Pressable onPress={onDiscard} hitSlop={6}>
              <Text className="text-[11px] text-muted-foreground">Discard</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text className="px-1 text-[11px] text-muted-foreground">Sending…</Text>
      )}
    </View>
  );
}

export function DaySeparator({ label }: { label: string }) {
  return (
    <View className="items-center py-3">
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}
