import { SlopForm } from '@/components/slop-form';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthActions } from '@convex-dev/auth/react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// No skip: saving sets onboardedAt, and the root layout moves on to Connect
// or the tabs. Sign out is the way back for someone in the wrong account.
export default function OnboardingScreen() {
  const { signOut } = useAuthActions();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row justify-end px-2">
        <Button variant="link" size="sm" onPress={() => void signOut()}>
          <Text className="text-muted-foreground">Sign out</Text>
        </Button>
      </View>
      <SlopForm submitLabel="Continue" />
    </SafeAreaView>
  );
}
