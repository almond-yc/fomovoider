import { ConnectionRow } from '@/components/connection-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Wordmark } from '@/components/wordmark';
import { api } from '@/convex/_generated/api';
import { connectors } from '@/lib/connectors';
import { useAuthActions } from '@convex-dev/auth/react';
import { useQuery } from 'convex/react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Shown while the user has no connected account (see app/_layout.tsx).
export default function ConnectScreen() {
  const viewer = useQuery(api.users.viewer);
  const { signOut } = useAuthActions();
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="pb-10">
        <View className="items-center gap-2 px-8 pb-8 pt-16">
          <Wordmark className="text-4xl" />
          <Text variant="muted" className="text-center">
            Connect an account to fill your feed.
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
