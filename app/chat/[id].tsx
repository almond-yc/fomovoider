import {
  Composer,
  DaySeparator,
  MessageBubble,
  MessageSkeletons,
  PendingBubble,
  PersonAvatar,
  useChatSources,
  type PendingMessage,
} from '@/components/chat';
import { EmptyState } from '@/components/empty-state';
import { PlatformBadge } from '@/components/platform-badge';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { conversationTitle, sendErrorText, unavailableText, unconfirmedPending, withDaySeparators, type ThreadItem } from '@/src/chat/format';
import type { ChatConversation, ChatMessage } from '@/src/chat/types';
import { useAction, useConvexAuth, usePaginatedQuery, useQuery } from 'convex/react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { MessageCircleOff } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, View, type HostInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const PAGE = 30;

type Row = ThreadItem | { kind: 'pending'; key: string; pending: PendingMessage };

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated } = useConvexAuth();
  const conversation = useQuery(api.conversations.get, isAuthenticated ? { conversationId: id } : 'skip');
  const sources = useChatSources();
  const sourceThread = sources.useThread(conversation as ChatConversation | null | undefined);
  const stored = usePaginatedQuery(
    api.messages.list,
    conversation && !sourceThread ? { conversationId: id } : 'skip',
    { initialNumItems: PAGE }
  );
  const sendAction = useAction(api.messages.send);
  const markRead = useAction(api.messages.markRead);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const headerHeight = useHeaderHeight();
  const [bodyTop, setBodyTop] = useState<number | null>(null);

  const sourceUnlocked = sourceThread?.status === 'unlocked';
  const unavailable = sourceUnlocked ? undefined : conversation?.unavailable;
  const readable = !!conversation && !conversation.unavailable;
  useEffect(() => {
    if (readable && !sourceThread) markRead({ conversationId: id }).catch(() => undefined);
  }, [readable, sourceThread, id, markRead]);

  const deliver = useCallback(
    async (key: string, text: string) => {
      setPending((all) => all.map((p) => (p.key === key ? { ...p, status: 'sending', error: undefined } : p)));
      let error: string | undefined;
      let sent: ChatMessage | undefined;
      try {
        if (sourceThread) {
          await sourceThread.send(text);
        } else {
          const result = await sendAction({ conversationId: id, text });
          if (result.ok) sent = result.message;
          else error = sendErrorText(result.error, conversation?.platform ?? '');
        }
      } catch (err) {
        error = sourceThread && err instanceof Error ? err.message : "Couldn't send. Check your connection.";
      }
      setPending((all) =>
        error
          ? all.map((p) => (p.key === key ? { ...p, status: 'failed', error } : p))
          : sent
            ? all.map((p) => (p.key === key ? { ...p, sent: { id: sent.id, text: sent.text, sentAt: sent.sentAt } } : p))
            : all.filter((p) => p.key !== key)
      );
    },
    [sourceThread, sendAction, id, conversation?.platform]
  );

  const send = (text: string) => {
    const key = `pending:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    setPending((all) => [...all, { key, text, status: 'sending' }]);
    void deliver(key, text);
  };

  const messages: ChatMessage[] | null = sourceThread
    ? sourceThread.messages
    : stored.status === 'LoadingFirstPage'
      ? null
      : (stored.results as ChatMessage[]);
  const visiblePending = useMemo(() => unconfirmedPending(pending, messages), [pending, messages]);
  useEffect(() => {
    if (visiblePending.length < pending.length) setPending(visiblePending);
  }, [visiblePending, pending.length]);
  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    const newestPending = [...visiblePending].reverse().map((p) => ({ kind: 'pending' as const, key: p.key, pending: p }));
    return [...newestPending, ...withDaySeparators(messages ?? [], now)];
  }, [messages, visiblePending]);

  if (conversation === null) {
    return (
      <Screen>
        <Header />
        <EmptyState
          icon={MessageCircleOff}
          title="Conversation not found"
          description="It may have been removed when its account was disconnected."
        />
      </Screen>
    );
  }

  const title = conversation ? conversationTitle(conversation) : '';
  const group = (conversation?.participants.length ?? 0) > 1;
  const blocked = !conversation
    ? undefined
    : unavailable
      ? unavailableText(unavailable.reason, conversation.platform)
      : !sourceThread && conversation.sendBlocked
        ? sendErrorText(conversation.sendBlocked, conversation.platform)
        : undefined;

  return (
    <Screen>
      <Header conversation={conversation as ChatConversation | undefined} title={title} />
      <View
        className="flex-1"
        onLayout={(e) => (e.currentTarget as HostInstance).measureInWindow((_x, y) => setBodyTop(y))}>
        <KeyboardAvoidingView
          className="flex-1"
          style={{ paddingTop: bodyTop === null ? 0 : Math.max(0, headerHeight - bodyTop) }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={bodyTop ?? headerHeight}>
          <View className="flex-1">
            <FlatList
              inverted
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              data={rows}
              keyExtractor={(r) => r.key}
              contentContainerClassName="gap-2 py-3"
              onEndReached={() => !sourceThread && stored.status === 'CanLoadMore' && stored.loadMore(PAGE)}
              onEndReachedThreshold={0.5}
              renderItem={({ item }) =>
                item.kind === 'day' ? (
                  <DaySeparator label={item.label} />
                ) : item.kind === 'pending' ? (
                  <PendingBubble
                    pending={item.pending}
                    onRetry={() => void deliver(item.key, item.pending.text)}
                    onDiscard={() => setPending((all) => all.filter((p) => p.key !== item.key))}
                  />
                ) : (
                  <MessageBubble message={item.message} showSender={group} />
                )
              }
            />
            {!conversation || (messages === null && !unavailable) ? (
              <View className="absolute inset-0 bg-background">
                <MessageSkeletons />
              </View>
            ) : null}
          </View>
          {sourceThread?.error ? (
            <Text className="px-5 py-2 text-center text-sm text-destructive">{sourceThread.error}</Text>
          ) : null}
          {conversation ? <Composer onSend={send} blocked={blocked} /> : null}
        </KeyboardAvoidingView>
      </View>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-background">
      {children}
    </SafeAreaView>
  );
}

// The native stack header: platform back button, the participant's avatar
// and name as the title, and the platform badge on the right.
function Header({ conversation, title }: { conversation?: ChatConversation; title?: string }) {
  return (
    <Stack.Screen
      options={{
        headerShown: true,
        title: title ?? '',
        headerBackTitle: 'Chats',
        headerShadowVisible: false,
        scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' },
        headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        headerTitle:
          conversation && title
            ? () => (
                <View className="flex-row items-center gap-2" accessibilityRole="header">
                  <PersonAvatar person={conversation.participants[0]} name={title} className="size-7" />
                  <Text className="max-w-56 font-sans-semibold text-base" numberOfLines={1}>
                    {title}
                  </Text>
                </View>
              )
            : undefined,
        headerRight: conversation
          ? () => (
              <View style={{ paddingRight: Platform.OS === 'web' ? 16 : 0 }}>
                <PlatformBadge platform={conversation.platform} />
              </View>
            )
          : undefined,
      }}
    />
  );
}
