import { platformName } from '@/components/platform-badge';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { cn } from '@/lib/utils';
import { useConvexAuth, useQuery } from 'convex/react';
import { ActivityIndicator, View } from 'react-native';

// Platforms the backend is still syncing (syncStatus.status), or undefined
// while loading or signed out.
export function useSyncStatus() {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.syncStatus.status, isAuthenticated ? {} : 'skip');
}

// "Syncing more from X and Instagram…" with a small spinner, shown while those
// platforms still have more to sync; nothing once they are done.
export function SyncingMore({ platforms, className }: { platforms: string[] | undefined; className?: string }) {
  if (!platforms?.length) return null;
  const names = platforms.map(platformName).join(' and ');
  return (
    <View
      className={cn('flex-row items-center gap-2 px-5 py-2', className)}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Syncing more from ${names}`}>
      <ActivityIndicator size="small" />
      <Text variant="muted" className="flex-1 text-xs" numberOfLines={1}>
        Syncing more from {names}…
      </Text>
    </View>
  );
}
