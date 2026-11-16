import { ConnectionRow } from '@/components/connection-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { connectors } from '@/lib/connectors';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { ScrollView, View } from 'react-native';

export default function SettingsScreen() {
  const viewer = useQuery(api.users.viewer);
  const { signOut } = useAuthActions();
  const today = useQuery(api.brief.today);
  const rerunToday = useMutation(api.brief.rerunToday);
  const status = today?.brief?.run.status;
  const running = status === 'collecting' || status === 'judging';
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-12"
      contentInsetAdjustmentBehavior="automatic">
      <Text variant="muted" className="px-5 pb-1 pt-6 text-xs uppercase tracking-wider">
        Accounts
      </Text>
      {connectors.map((connector) => (
        <ConnectionRow
          key={connector.platform}
          connector={connector}
          account={viewer?.accounts.find((a) => a.platform === connector.platform)}
          variant="settings"
        />
      ))}
      <Text variant="muted" className="px-5 pb-1 pt-8 text-xs uppercase tracking-wider">
        Morning Brief
      </Text>
      <View className="px-5 pt-2">
        <Button variant="outline" disabled={!today || running} onPress={() => void rerunToday()}>
          <Text>{running ? 'Running…' : "Rerun today's brief"}</Text>
        </Button>
      </View>
      <View className="mt-8 gap-3 px-5">
        {viewer?.email ? <Text variant="muted">Signed in as {viewer.email}</Text> : null}
        <Button variant="outline" onPress={() => void signOut()}>
          <Text>Sign out</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
