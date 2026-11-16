import { ConnectionRow } from '@/components/connection-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Wordmark } from '@/components/wordmark';
import { api } from '@/convex/_generated/api';
import { connectors } from '@/lib/connectors';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Shown during onboarding until the user taps Continue, and whenever no
// account is connected (see lib/onboarding-gate.ts). After each platform
// connects, the user comes back here to connect the other one. Once the gate
// opens the app (connected, onboarding done) it goes back to the tabs already
// in the stack, a /connect link from Settings included, instead of the root
// guard replacing it with a second copy of the tabs.
export default function ConnectScreen() {
  const viewer = useQuery(api.users.viewer);
  const finishConnectStep = useMutation(api.users.finishConnectStep);
  const { signOut } = useAuthActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const connected = viewer?.accounts.some((a) => a.status === 'active') ?? false;

  const inApp = connected && viewer?.connectStepPending !== true;

  useEffect(() => {
    if (inApp) router.dismissTo('/');
  }, [inApp]);

  async function continueToApp() {
    setBusy(true);
    setError(undefined);
    try {
      await finishConnectStep();
    } catch {
      setError("Couldn't continue. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="pb-10">
        <View className="items-center gap-2 px-8 pb-8 pt-16">
          <Wordmark className="text-2xl" />
          <Text variant="muted" className="text-center">
            Connect your accounts to fill your feed.
          </Text>
        </View>
        {connectors.map((connector) => (
          <ConnectionRow
            key={connector.platform}
            connector={connector}
            account={viewer?.accounts.find((a) => a.platform === connector.platform)}
            variant="connect"
          />
        ))}
        <View className="mt-8 gap-2 px-6">
          <Button size="lg" disabled={!connected || busy} onPress={() => void continueToApp()}>
            {busy ? <ActivityIndicator /> : <Text>Continue</Text>}
          </Button>
          <Text variant="muted" className="text-center text-xs leading-4">
            {error ?? (connected ? 'You can connect more accounts later in Settings.' : 'Connect at least one account to continue.')}
          </Text>
        </View>
        <View className="mt-10 items-center gap-1">
          {viewer?.email ? <Text variant="muted">Signed in as {viewer.email}</Text> : null}
          <Button variant="link" size="sm" onPress={() => void signOut()}>
            <Text>Sign out</Text>
          </Button>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
