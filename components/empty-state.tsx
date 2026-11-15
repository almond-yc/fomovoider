import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-background px-10">
      <Icon as={icon} size={32} className="text-muted-foreground" />
      <Text className="text-center font-title text-2xl">{title}</Text>
      <Text variant="muted" className="text-center leading-5">
        {description}
      </Text>
    </View>
  );
}
