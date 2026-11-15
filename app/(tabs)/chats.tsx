import { EmptyState } from '@/components/empty-state';
import { MessagesSquare } from 'lucide-react-native';

export default function ChatsScreen() {
  return (
    <EmptyState
      icon={MessagesSquare}
      title="No conversations yet"
      description="Your messages from every platform will land in this one inbox."
    />
  );
}
