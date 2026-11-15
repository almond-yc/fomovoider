import { EmptyState } from '@/components/empty-state';
import { Text } from '@/components/ui/text';
import { Link } from 'expo-router';
import { MessagesSquare } from 'lucide-react-native';
import { View } from 'react-native';

export default function ChatsScreen() {
  return (
    <View className="flex-1 bg-background">
      <EmptyState
        icon={MessagesSquare}
        title="No conversations yet"
        description="Your messages from every platform will land in this one inbox."
      />
      <Link href="/x-chat" className="p-6 text-center">
        <Text className="font-medium">Open X Chat</Text>
      </Link>
    </View>
  );
}
