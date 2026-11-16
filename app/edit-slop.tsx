import { SlopForm } from '@/components/slop-form';
import { Icon } from '@/components/ui/icon';
import { api } from '@/convex/_generated/api';
import { useQuery } from 'convex/react';
import { router } from 'expo-router';
import { X } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

function backToFeed() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

// Opened from the Feed header; the root layout only allows it once onboarded.
export default function EditSlopScreen() {
  const viewer = useQuery(api.users.viewer);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="h-11 flex-row items-center justify-end px-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={backToFeed}
          hitSlop={8}
          className="p-2">
          <Icon as={X} size={22} />
        </Pressable>
      </View>
      {viewer !== undefined && (
        <SlopForm initialValue={viewer?.slopDescription ?? ''} submitLabel="Save" onSaved={backToFeed} />
      )}
    </SafeAreaView>
  );
}
