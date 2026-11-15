import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { ChatPerson } from '@/src/chat/types';

export function PersonAvatar({ person, name, className }: { person?: ChatPerson; name: string; className?: string }) {
  return (
    <Avatar alt={name} className={className}>
      {person?.avatarUrl ? <AvatarImage source={{ uri: person.avatarUrl }} /> : null}
      <AvatarFallback>
        <Text className={cn('text-muted-foreground', className?.includes('size-1') ? 'text-base' : 'text-xs')}>
          {name.slice(0, 1).toUpperCase()}
        </Text>
      </AvatarFallback>
    </Avatar>
  );
}
