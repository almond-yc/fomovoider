import { Skeleton } from '@/components/ui/skeleton';
import { View } from 'react-native';

export function ConversationRowSkeleton() {
  return (
    <View className="flex-row items-center gap-3 px-5 py-3.5" accessibilityLabel="Loading">
      <Skeleton className="size-11 rounded-full" />
      <View className="flex-1 gap-2">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
      </View>
    </View>
  );
}
