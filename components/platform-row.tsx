import { PlatformBadge } from '@/components/platform-badge';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { PlatformId } from '@/src/connectors/types';
import type { ReactNode } from 'react';
import { View } from 'react-native';

// One platform: full-color logo, name with a line under it, an action on the
// right, and optional status lines and content below the name.
export function PlatformRow({
  platform,
  name,
  subtitle,
  status,
  statusTone = 'muted',
  action,
  children,
}: {
  platform: PlatformId;
  name: string;
  subtitle: string;
  status?: string;
  statusTone?: 'muted' | 'destructive';
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View className="px-5 py-4">
      <View className="flex-row items-center gap-4">
        <PlatformBadge platform={platform} size={44} />
        <View className="flex-1 gap-0.5">
          <Text className="font-sans-semibold text-base">{name}</Text>
          <Text variant="muted" numberOfLines={1}>
            {subtitle}
          </Text>
          {status ? (
            <Text
              className={cn('text-xs', statusTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}
              numberOfLines={2}>
              {status}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}
