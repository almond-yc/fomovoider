import { ConversationRow, ConversationRowSkeleton, useChatSources } from '@/components/chat';
import { EmptyState } from '@/components/empty-state';
import { SyncingMore, useSyncStatus } from '@/components/syncing-more';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { mergeConversations, platformName } from '@/src/chat/format';
import type { ChatConversation } from '@/src/chat/types';
import { useConvexAuth, usePaginatedQuery, useQuery } from 'convex/react';
import { router } from 'expo-router';
import { CircleAlert, MessagesSquare } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';

const PAGE = 30;

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export default function ChatsScreen() {
  const sources = useChatSources();
  const { isAuthenticated } = useConvexAuth();
  const { results, status, loadMore } = usePaginatedQuery(api.conversations.list, isAuthenticated ? {} : 'skip', {
    initialNumItems: PAGE,
  });
  const rows = !isAuthenticated || status === 'LoadingFirstPage' ? undefined : (results as ChatConversation[]);
  const fromSources = sources.useConversations(rows);
  const conversations = useMemo(() => mergeConversations(rows, fromSources), [rows, fromSources]);
  const accounts = useQuery(api.accounts.list, isAuthenticated ? {} : 'skip');
  const now = useNow();
  const syncing = useSyncStatus()?.chats;

  const needsReconnect = (accounts ?? []).filter((a) => a.status === 'expired').map((a) => platformName(a.platform));

  const onPress = (conversation: ChatConversation) =>
    conversation.unavailable
      ? sources.openUnavailable?.(conversation)
      : () => router.push({ pathname: '/chat/[id]', params: { id: conversation.id } });

  const banner = needsReconnect.length ? (
    <View className="mx-5 mb-1 mt-3 flex-row items-center gap-2 rounded-lg border border-border px-3 py-2.5">
      <Icon as={CircleAlert} size={16} className="text-destructive" />
      <Text className="flex-1 text-sm">
        {needsReconnect.join(' and ')} {needsReconnect.length > 1 ? 'need' : 'needs'} reconnecting. Chats there won't
        update until then.
      </Text>
    </View>
  ) : undefined;
  const header = (
    <>
      {banner}
      <SyncingMore platforms={syncing} />
    </>
  );

  if (!rows) {
    return (
      <FlatList
        key="loading"
        className="flex-1 bg-background"
        contentContainerClassName="pt-1"
        contentInsetAdjustmentBehavior="automatic"
        data={[0, 1, 2, 3, 4, 5]}
        keyExtractor={String}
        renderItem={() => <ConversationRowSkeleton />}
        scrollEnabled={false}
      />
    );
  }

  if (conversations.length === 0) {
    return (
      <FlatList
        key="empty"
        className="flex-1 bg-background"
        contentContainerClassName="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        data={[]}
        renderItem={() => null}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyState
            icon={MessagesSquare}
            title="No conversations yet"
            description="Your messages from every platform will land in this one inbox."
          />
        }
      />
    );
  }

  return (
    <FlatList
      key="conversations"
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      data={conversations}
      keyExtractor={(c) => c.id}
      ListHeaderComponent={header}
      contentContainerClassName="py-1"
      renderItem={({ item }) => (
        <ConversationRow
          conversation={item}
          now={now}
          onPress={onPress(item)}
        />
      )}
      onEndReached={() => status === 'CanLoadMore' && loadMore(PAGE)}
      onEndReachedThreshold={0.5}
      ListFooterComponent={status === 'LoadingMore' ? <ConversationRowSkeleton /> : undefined}
    />
  );
}
