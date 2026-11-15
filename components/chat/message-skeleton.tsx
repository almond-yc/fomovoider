import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { View } from 'react-native';

const SHAPES = [
  { mine: false, width: 'w-3/5' },
  { mine: true, width: 'w-2/5' },
  { mine: false, width: 'w-1/2' },
  { mine: true, width: 'w-3/5' },
];

export function MessageSkeletons() {
  return (
    <View className="flex-1 justify-end gap-3 px-4 pb-4" accessibilityLabel="Loading messages">
      {SHAPES.map((s, i) => (
        <Skeleton key={i} className={cn('h-9 rounded-2xl', s.width, s.mine ? 'self-end' : 'self-start')} />
      ))}
    </View>
  );
}
