import { EmptyState } from '@/components/empty-state';
import { CircleCheck } from 'lucide-react-native';

export default function FeedScreen() {
  return (
    <EmptyState
      icon={CircleCheck}
      title="You're all caught up"
      description="New posts from the people you follow will show up here."
    />
  );
}
