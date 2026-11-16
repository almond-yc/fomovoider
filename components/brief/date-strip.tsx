import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';

const DAYS_SHOWN = 14;
const ITEM_WIDTH = 64;
const GAP = 8;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// today and the days before it, oldest first, as YYYY-MM-DD. Date math on
// noon UTC so no zone or DST shift can move a day.
export function stripDays(today: string, count = DAYS_SHOWN) {
  const noon = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(noon - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

// "Mon 11/9"
export function dayLabel(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()], monthDay: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` };
}

// A row of day rectangles with today in the middle of the screen and earlier
// days to its left. Days without a brief can't be picked.
export function DateStrip({
  today,
  selected,
  available,
  onSelect,
}: {
  today: string;
  selected: string;
  available: ReadonlySet<string>;
  onSelect: (date: string) => void;
}) {
  const days = stripDays(today);
  const scroll = useRef<ScrollViewInstance>(null);
  const [width, setWidth] = useState(0);
  // Padding on both ends lets the first and last day scroll to the center.
  const inset = Math.max(0, (width - ITEM_WIDTH) / 2);

  useEffect(() => {
    if (width === 0) return;
    const index = Math.max(0, days.indexOf(selected));
    scroll.current?.scrollTo({ x: index * (ITEM_WIDTH + GAP), animated: false });
  }, [width, today]);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} className="border-b border-border py-3">
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: inset, gap: GAP }}
        snapToInterval={ITEM_WIDTH + GAP}
        decelerationRate="fast">
        {days.map((date) => {
          const { weekday, monthDay } = dayLabel(date);
          const enabled = date === today || available.has(date);
          const active = date === selected;
          return (
            <Pressable
              key={date}
              disabled={!enabled}
              onPress={() => onSelect(date)}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: !enabled }}
              accessibilityLabel={`${weekday} ${monthDay}${date === today ? ', today' : ''}`}
              style={{ width: ITEM_WIDTH }}
              className={cn(
                'items-center gap-0.5 rounded-md border py-2',
                active ? 'border-foreground bg-foreground' : 'border-border',
                !enabled && 'opacity-35',
              )}>
              <Text className={cn('text-xs', active ? 'text-background' : 'text-muted-foreground')}>{weekday}</Text>
              <Text className={cn('font-sans-semibold text-sm', active && 'text-background')}>{monthDay}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
