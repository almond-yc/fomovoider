import { Skeleton } from '@/components/ui/skeleton';
import { View } from 'react-native';

export function ContentItemSkeleton({ withMedia = false }: { withMedia?: boolean }) {
  return (
    <View className="flex-row gap-3 px-5 py-5" accessibilityLabel="Loading">
      {/* avatar hidden for now, per Alex
      <Skeleton className="size-8 rounded-full" />
      */}
      <View className="flex-1 gap-2.5 pt-1">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        {withMedia ? <Skeleton className="aspect-[4/3] w-full" /> : null}
      </View>
    </View>
  );
}
