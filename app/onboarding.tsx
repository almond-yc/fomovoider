import { SlopForm } from '@/components/slop-form';
import { SafeAreaView } from 'react-native-safe-area-context';

// No skip: saving sets onboardedAt, and the root layout moves on to Connect
// or the tabs.
export default function OnboardingScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <SlopForm submitLabel="Continue" />
    </SafeAreaView>
  );
}
