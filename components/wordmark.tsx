import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export function Wordmark({ className }: { className?: string }) {
  return (
    <Text className={cn('font-title text-lg', className)} accessibilityRole="header">
      Fomovoider
    </Text>
  );
}
