import { EmptyState } from '@/components/empty-state';
import { ContentItem, ContentItemSkeleton, DashedDivider, type FeedPagePost, useSeenBatches } from '@/components/feed';
import { platformName } from '@/components/platform-badge';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { connectors } from '@/lib/connectors';
import type { FunctionReturnType } from 'convex/server';
import { useConvex, useConvexAuth, useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { router, Stack } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import { CircleCheck, Link2 } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, View } from 'react-native';

type Account = FunctionReturnType<typeof api.accounts.list>[number];

const PAGE_SIZE = 20;

// Opened by link, it has no screen to go back to, so its back button goes to
// the tabs.
export default function FullFeedScreen() {
  const canGoBack = router.canGoBack();
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Full feed',
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
          headerLeft: canGoBack
            ? undefined
            : (props) => <HeaderBackButton {...props} displayMode="minimal" onPress={() => router.replace('/')} />,
        }}
      />
      <FeedScreen />
    </>
  );
}

function FeedScreen() {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const accounts = useQuery(api.accounts.list, isAuthenticated ? {} : 'skip');
  const [session, setSession] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled(
      (accounts ?? []).flatMap(({ platform }) => {
        const sync = connectors.find((c) => c.platform === platform)?.sync;
        return sync ? [convex.mutation(sync, {})] : [];
      }),
    );
    setSession((s) => s + 1);
    setRefreshing(false);
  }, [accounts, convex]);

  if (accounts === undefined) return <SkeletonList />;
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title="No accounts connected"
        description="Connect X or Instagram and posts from the people you follow will show up here."
      />
    );
  }
  return (
    <FeedSession
      key={session}
      notices={<AccountNotices accounts={accounts} />}
      refreshing={refreshing}
      onRefresh={refresh}
    />
  );
}

// One pass through the feed. Pull to refresh starts a new one, which only
// shows posts newer than where the last one was caught up.
function FeedSession({
  notices,
  refreshing,
  onRefresh,
}: {
  notices: ReactElement;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(api.feed.page, {}, { initialNumItems: PAGE_SIZE });
  const connectorsCaughtUp = useQuery(api.feed.connectorsCaughtUp);
  const markCaughtUp = useMutation(api.feed.markCaughtUp);
  const markOpened = useMutation(api.postStates.markOpened);
  const setHidden = useMutation(api.postStates.setHidden);
  const setSaved = useMutation(api.postStates.setSaved);
  const onViewableItemsChanged = useSeenBatches((item) => (item as FeedPagePost)._id);
  // markCaughtUp moves the feed's end past every post shown, so feed.page
  // empties right after; the session keeps showing what it reached.
  const [reached, setReached] = useState<FeedPagePost[] | null>(null);
  const [hidden, setHiddenIds] = useState<ReadonlySet<Id<'posts'>>>(new Set());
  const [saved, setSavedIds] = useState<ReadonlyMap<Id<'posts'>, boolean>>(new Map());

  // feed.page drops hidden posts after paginating, so a page can come back
  // empty and leave the list's length (and onEndReached) unchanged. Ask for
  // the next page until one adds posts or the feed is exhausted.
  const requestedAt = useRef<number | null>(null);
  const loadNext = () => {
    requestedAt.current = results.length;
    loadMore(PAGE_SIZE);
  };
  useEffect(() => {
    if (status !== 'CanLoadMore') return;
    if (results.length === 0 || results.length === requestedAt.current) loadNext();
    else requestedAt.current = null;
  }, [status, results.length]);

  const caughtUp = reached !== null || (status === 'Exhausted' && connectorsCaughtUp === true);
  const posts = (reached ?? results).filter((p) => !hidden.has(p._id));

  const onEndReached = () => {
    if (status === 'CanLoadMore') loadNext();
    if (!caughtUp || reached !== null || results.length === 0) return;
    setReached(results);
    void markCaughtUp({ until: Math.max(...results.map((p) => p.createdAt)) });
  };

  const showActions = (post: FeedPagePost) => {
    const isSaved = saved.get(post._id) ?? post.savedAt !== undefined;
    Alert.alert(`${post.author.displayName} on ${platformName(post.platform)}`, undefined, [
      {
        text: isSaved ? 'Unsave' : 'Save',
        onPress: () => {
          setSavedIds((m) => new Map(m).set(post._id, !isSaved));
          void setSaved({ postId: post._id, saved: !isSaved });
        },
      },
      {
        text: 'Hide',
        style: 'destructive',
        onPress: () => {
          setHiddenIds((s) => new Set(s).add(post._id));
          void setHidden({ postId: post._id, hidden: true });
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  if (status === 'LoadingFirstPage') return <SkeletonList />;
  if (caughtUp && posts.length === 0) {
    return (
      <FlatList
        key="caught-up"
        data={[]}
        renderItem={() => null}
        className="bg-background"
        contentContainerClassName="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={notices}
        ListEmptyComponent={<CaughtUp />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    );
  }
  return (
    <FlatList
      key="feed"
      data={posts}
      className="bg-background"
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={notices}
      keyExtractor={(post) => post._id}
      renderItem={({ item }) => (
        <Pressable onLongPress={() => showActions(item)} accessibilityHint="Long press to save or hide">
          <ContentItem
            post={item}
            saved={saved.get(item._id) ?? item.savedAt !== undefined}
            onOpen={() => void markOpened({ postId: item._id })}
          />
        </Pressable>
      )}
      ItemSeparatorComponent={DashedDivider}
      ListFooterComponent={
        caughtUp ? (
          <>
            <DashedDivider />
            <CaughtUp className="flex-none py-16" />
          </>
        ) : status === 'Exhausted' ? (
          <Text variant="muted" className="px-5 py-10 text-center text-sm">
            Older posts are still syncing.
          </Text>
        ) : (
          <ContentItemSkeleton />
        )
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.2}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={{ itemVisiblePercentThreshold: 50, minimumViewTime: 300 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    />
  );
}

function AccountNotices({ accounts }: { accounts: Account[] }) {
  const notices = accounts.flatMap((account) => {
    const notice = accountNotice(account);
    return notice ? [{ platform: account.platform, notice }] : [];
  });
  if (notices.length === 0) return null;
  return (
    <View className="gap-1 px-5 py-2">
      {notices.map(({ platform, notice }) => (
        <Text key={platform} variant="muted" className="text-xs" numberOfLines={1}>
          {notice}
        </Text>
      ))}
    </View>
  );
}

function accountNotice({ platform, status, lastError }: Account): string | null {
  const name = platformName(platform);
  if (status === 'expired') return `${name} signed out. Reconnect it in Settings.`;
  if (status !== 'error') return null;
  switch (lastError?.kind) {
    case 'budget_exhausted':
      return `${name} credits used up. New posts will come in once they reset.`;
    case 'rate_limited':
      return `${name} is rate limiting us. New posts will come in later.`;
    case 'network':
      return `Couldn't reach ${name}. Showing what was already synced.`;
    default:
      return `Couldn't refresh ${name}. Showing what was already synced.`;
  }
}

function CaughtUp({ className }: { className?: string }) {
  return (
    <EmptyState
      icon={CircleCheck}
      title="You're all caught up"
      description="New posts from the people you follow will show up here."
      className={className}
    />
  );
}

function SkeletonList() {
  return (
    <FlatList
      className="bg-background"
      contentInsetAdjustmentBehavior="automatic"
      data={[0, 1, 2]}
      keyExtractor={String}
      renderItem={({ index }) => <ContentItemSkeleton withMedia={index === 0} />}
      ItemSeparatorComponent={DashedDivider}
      scrollEnabled={false}
    />
  );
}
