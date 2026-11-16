import { useLocalToday } from '@/components/brief/brief-screen';
import { ConnectionRow } from '@/components/connection-row';
import { XChatPasscodeRow } from '@/components/x-chat-passcode-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { connectors } from '@/lib/connectors';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { Fragment } from 'react';
import { ScrollView, View } from 'react-native';

export default function SettingsScreen() {
  const viewer = useQuery(api.users.viewer);
  const { signOut } = useAuthActions();
  const today = useQuery(api.brief.byDate, { date: useLocalToday() });
  const rerunToday = useMutation(api.brief.rerunToday);
  const status = today?.run.status;
  const running = status === 'collecting' || status === 'judging';
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-12"
      contentInsetAdjustmentBehavior="automatic">
      <Text variant="muted" className="px-5 pb-1 pt-6 text-xs uppercase tracking-wider">
        Accounts
      </Text>
      {connectors.map((connector) => {
        const account = viewer?.accounts.find((a) => a.platform === connector.platform);
        return (
          <Fragment key={connector.platform}>
            <ConnectionRow connector={connector} account={account} variant="settings" />
            {connector.platform === 'x' && account?.status === 'active' ? <XChatPasscodeRow /> : null}
          </Fragment>
        );
      })}
      <Text variant="muted" className="px-5 pb-1 pt-8 text-xs uppercase tracking-wider">
        Morning Brief
      </Text>
      <View className="px-5 pt-2">
        <Button variant="outline" disabled={today === undefined || running} onPress={() => void rerunToday()}>
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
