import { ContentItem, ContentItemSkeleton, DashedDivider } from '@/components/feed';
import { platformName } from '@/components/platform-badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { CircleCheck, Coffee, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';

import { DateStrip } from './date-strip';

type Brief = NonNullable<FunctionReturnType<typeof api.brief.byDate>>;

// The Feed tab: the Morning Brief for the picked day.
export function BriefScreen() {
  const dates = useQuery(api.brief.dates);
  const setTimeZone = useMutation(api.brief.setTimeZone);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) void setTimeZone({ timeZone: zone }).catch(() => {});
  }, [setTimeZone]);

  const available = useMemo(() => new Set(dates?.days.map((d) => d.date)), [dates]);
  const selected = picked ?? dates?.today;
  const isToday = selected !== undefined && selected === dates?.today;
  const today = useQuery(api.brief.today, isToday ? {} : 'skip');
  const past = useQuery(api.brief.byDate, selected && !isToday ? { date: selected } : 'skip');
  const brief = isToday ? (today === undefined ? undefined : today.brief) : past;

  if (dates === undefined || selected === undefined) return <Loading />;

  return (
    <View className="flex-1 bg-background">
      <DateStrip today={dates.today} selected={selected} available={available} onSelect={setPicked} />
      <BriefBody brief={brief} isToday={isToday} />
    </View>
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
      keyExtractor={(item) => item._id}
      ListHeaderComponent={<Skipped skipped={run.skipped} />}
      ListEmptyComponent={
        <View className="items-center gap-2 px-10 pt-16">
          <Icon as={Sparkles} size={28} className="text-muted-foreground" />
          <Text className="text-center font-title text-xl">Nothing worth your time</Text>
          <Text variant="muted" className="text-center">
            Everything new was slop. Enjoy the quiet.
          </Text>
        </View>
      }
      renderItem={({ item }) => <ContentItem post={item.post} title={item.post.title} />}
      ItemSeparatorComponent={DashedDivider}
      ListFooterComponent={footer}
    />
  );
}

function Skipped({ skipped }: { skipped: Brief['run']['skipped'] }) {
  if (skipped.length === 0) return null;
  const names = [...new Set(skipped.map((s) => platformName(s.platform)))].join(' and ');
  return (
    <Text variant="muted" className="px-5 pt-3 text-xs">
      Without {names} today.
    </Text>
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
