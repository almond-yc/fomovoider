import { Text } from '@/components/ui/text';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function OnboardingScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background px-6">
      <Text className="font-title text-3xl">What's slop for you?</Text>
    </SafeAreaView>
  );
}
