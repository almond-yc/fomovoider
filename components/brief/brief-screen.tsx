import { ContentItem, ContentItemSkeleton, DashedDivider, useSeenBatches } from '@/components/feed';
import { platformName } from '@/components/platform-badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { CircleCheck, Coffee, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DateStrip } from './date-strip';

type Brief = NonNullable<FunctionReturnType<typeof api.brief.byDate>>;
type BriefItem = Brief['items'][number];

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Today in the device's zone (the zone the brief runs in, via
// brief.setTimeZone), rechecked every minute and when the app comes back, so
// the screen rolls over at midnight without a database write.
export function useLocalToday() {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const check = () => setToday(localDate());
    const timer = setInterval(check, 60_000);
    const sub = AppState.addEventListener('change', (state) => state === 'active' && check());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, []);
  return today;
}

// The Feed tab: the Morning Brief for the picked day.
export function BriefScreen() {
  const today = useLocalToday();
  const dates = useQuery(api.brief.dates);
  const setTimeZone = useMutation(api.brief.setTimeZone);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) void setTimeZone({ timeZone: zone }).catch(() => {});
  }, [setTimeZone]);

  const available = useMemo(() => new Set(dates?.days.map((d) => d.date)), [dates]);
  // A day picked before midnight stays picked; otherwise follow today.
  const selected = picked !== null && picked < today ? picked : today;
  const brief = useQuery(api.brief.byDate, { date: selected });

  // On iOS the root header overlaps the tab's content; the top safe area
  // includes it there, and is zero on Android and web.
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      {dates === undefined ? (
        <Loading />
      ) : (
        <>
          <DateStrip today={today} selected={selected} available={available} onSelect={setPicked} />
          <BriefBody key={selected} brief={brief} isToday={selected === today} />
        </>
      )}
    </SafeAreaView>
  );
}

function BriefBody({ brief, isToday }: { brief: Brief | null | undefined; isToday: boolean }) {
  if (brief === undefined) return <Loading />;
  if (brief === null) {
    return isToday ? (
      <Message icon={Coffee} title="Your brief arrives at 7:00" description="Every morning we read your feeds and keep only what's worth your time." />
    ) : (
      <Message icon={Coffee} title="No brief that day" description="Pick another day." />
    );
  }
  const { run, items } = brief;
  if (run.status === 'collecting' || run.status === 'judging') return <Preparing />;
  if (run.status === 'failed' && items.length === 0) {
    return <Message icon={TriangleAlert} title="We couldn't prepare this brief" description="It'll be back tomorrow morning." />;
  }
  return <BriefList run={run} items={items} />;
}

function BriefList({ run, items }: Brief) {
  const markOpened = useMutation(api.postStates.markOpened);
  const setHidden = useMutation(api.postStates.setHidden);
  const setSaved = useMutation(api.postStates.setSaved);
  const onViewableItemsChanged = useSeenBatches((item) => (item as BriefItem).post._id);

  // brief.byDate reads post states, so a save or hide shows up on its own.
  const showActions = ({ post }: BriefItem) => {
    const saved = post.savedAt !== undefined;
    Alert.alert(`${post.author.displayName} on ${platformName(post.platform)}`, undefined, [
      { text: saved ? 'Unsave' : 'Save', onPress: () => void setSaved({ postId: post._id, saved: !saved }) },
      { text: 'Hide', style: 'destructive', onPress: () => void setHidden({ postId: post._id, hidden: true }) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const filtered = run.counts.filtered;
  const footer = (
    <View className="items-center gap-3 px-10 pb-16 pt-8">
      {filtered > 0 ? (
        <Text variant="muted">
          {filtered} {filtered === 1 ? 'post' : 'posts'} filtered out
        </Text>
      ) : null}
      <Icon as={CircleCheck} size={28} className="text-muted-foreground" />
      <Text className="text-center font-title text-xl">You're all caught up</Text>
    </View>
  );
  return (
    <FlatList
      data={items}
      contentInsetAdjustmentBehavior="automatic"
      keyExtractor={(item) => item._id}
      ListEmptyComponent={
        <View className="items-center gap-2 px-10 pt-16">
          <Icon as={Sparkles} size={28} className="text-muted-foreground" />
          <Text className="text-center font-title text-xl">Nothing worth your time</Text>
          <Text variant="muted" className="text-center">
            Everything new was slop. Enjoy the quiet.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable onLongPress={() => showActions(item)} accessibilityHint="Long press to save or hide">
          <ContentItem
            post={item.post}
            saved={item.post.savedAt !== undefined}
            onOpen={() => void markOpened({ postId: item.post._id })}
          />
        </Pressable>
      )}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={{ itemVisiblePercentThreshold: 50, minimumViewTime: 300 }}
      ItemSeparatorComponent={DashedDivider}
      ListFooterComponent={footer}
    />
  );
}

function Preparing() {
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-2 px-5 pt-5">
        <ActivityIndicator size="small" />
        <Text className="font-sans-medium">Preparing your brief</Text>
      </View>
      <Text variant="muted" className="px-5 pt-1">
        Reading today's posts and leaving out the slop.
      </Text>
      {[true, false, false].map((withMedia, i) => (
        <ContentItemSkeleton key={i} withMedia={withMedia} />
      ))}
    </View>
  );
}

function Loading() {
  return (
    <View className="flex-1 bg-background">
      {[true, false, false].map((withMedia, i) => (
        <ContentItemSkeleton key={i} withMedia={withMedia} />
      ))}
    </View>
  );
}

function Message({ icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 px-10 pb-24">
      <Icon as={icon} size={32} className="text-muted-foreground" />
      <Text className="text-center font-title text-2xl">{title}</Text>
      <Text variant="muted" className="text-center leading-5">
        {description}
      </Text>
    </View>
  );
}
