import { PlatformRow } from '@/components/platform-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { errorMessage, isMissingFunction, type ClientConnector } from '@/lib/connectors';
import { useInstagramWebView } from '@/src/instagram/webview/InstagramWebViewHost';
import type { RefreshResult } from '@/src/instagram/refresh';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

export type AccountView = NonNullable<FunctionReturnType<typeof api.users.viewer>>['accounts'][number];

type Attempt = { state: 'idle' } | { state: 'connecting' } | { state: 'error'; message: string };

// A platform row that connects through the connector registry. "connect" is
// the Connect screen; "settings" adds the handle, last sync, Sync now and
// Disconnect. Instagram logs in through the app's web view and has Refresh now
// instead of Sync now.
export function ConnectionRow({
  connector,
  account,
  variant,
}: {
  connector: ClientConnector;
  account?: AccountView;
  variant: 'connect' | 'settings';
}) {
  const convex = useConvex();
  const ig = useInstagramWebView();
  const isInstagram = connector.platform === 'instagram';
  const igDevice = useQuery(api.instagram.devices.status, isInstagram ? {} : 'skip');
  const igState = useQuery(api.instagram.webview.state, isInstagram && variant === 'settings' ? {} : 'skip');
  const [attempt, setAttempt] = useState<Attempt>({ state: 'idle' });
  const [note, setNote] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  async function connect() {
    if (!connector.login) return;
    setNote(undefined);
    try {
      const login = connector.login({ convex });
      if (login.kind === 'webview') {
        ig.showLogin();
        return;
      }
      setAttempt({ state: 'connecting' });
      if (login.kind === 'server') {
        await login.login();
      } else {
        const session = await login.login();
        await convex.mutation(api.accounts.connect, { session });
        const started = connector.sync ? await convex.mutation(connector.sync, {}) : true;
        if (started === false) setNote("The first sync couldn't start yet. Tap Sync now in a few minutes.");
      }
      setAttempt({ state: 'idle' });
    } catch (err) {
      setAttempt({ state: 'error', message: errorMessage(err, connector) });
    }
  }

  async function sync() {
    if (!connector.sync) return;
    setNote('Syncing…');
    try {
      const started = await convex.mutation(connector.sync, {});
      setNote(started === false ? 'Synced recently. Try again in a few minutes.' : undefined);
    } catch (err) {
      setNote(errorMessage(err, connector));
    }
  }

  async function refresh() {
    setRefreshing(true);
    setNote('Refreshing…');
    try {
      setNote(refreshNote(await ig.refreshNow()));
    } catch (err) {
      setNote(errorMessage(err, connector));
    } finally {
      setRefreshing(false);
    }
  }

  function disconnect() {
    Alert.alert(
      `Disconnect ${connector.name}?`,
      `Its posts and messages are removed from Fomovoider.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              if (connector.disconnect) {
                await convex.mutation(connector.disconnect, {}).catch((err) => {
                  if (!isMissingFunction(err)) throw err;
                });
              }
              await convex.mutation(api.accounts.disconnect, { platform: connector.platform });
              setNote(undefined);
            } catch (err) {
              setNote(errorMessage(err, connector));
            }
          },
        },
      ]
    );
  }

  const busy = attempt.state === 'connecting';
  const broken = account?.status === 'expired' || account?.status === 'error';
  const igConnected = isInstagram && (igDevice?.paired === true || ig.status === 'ready');
  const paused = igState ? pausedLine(igState) : undefined;
  const status = describe(connector, account, attempt, variant, igConnected);

  let action;
  if (busy) {
    action = <ActivityIndicator className="px-4" />;
  } else if (variant === 'settings' && account) {
    action = (
      <Button variant="outline" size="sm" onPress={disconnect}>
        <Text>Disconnect</Text>
      </Button>
    );
  } else if ((!account && !igConnected) || broken) {
    action = (
      <Button size="sm" disabled={!connector.login} onPress={connect}>
        <Text>{account ? 'Reconnect' : 'Connect'}</Text>
      </Button>
    );
  }

  const links: { label: string; onPress: () => void }[] = [];
  if (account && !busy) {
    if (variant === 'settings' && broken && connector.login) links.push({ label: 'Reconnect', onPress: connect });
    if ((account.status === 'active' || account.status === 'pending') && connector.sync) {
      links.push({ label: 'Sync now', onPress: sync });
    }
    if (variant === 'settings' && isInstagram && !broken && !refreshing && !paused) {
      links.push({ label: 'Refresh now', onPress: refresh });
    }
    if (variant === 'connect') links.push({ label: 'Disconnect', onPress: disconnect });
  }

  return (
    <PlatformRow
      platform={connector.platform}
      name={connector.name}
      subtitle={variant === 'settings' && account?.me ? `@${account.me.handle}` : connector.description}
      status={note ?? paused ?? status.text}
      statusTone={note || paused ? 'muted' : status.tone}
      action={action}>
      {links.length ? (
        <View className="ml-[60px] mt-1 flex-row gap-4">
          {links.map((link) => (
            <Button key={link.label} variant="link" size="sm" className="h-auto px-0 py-1" onPress={link.onPress}>
              <Text className="text-xs">{link.label}</Text>
            </Button>
          ))}
        </View>
      ) : null}
    </PlatformRow>
  );
}

function describe(
  connector: ClientConnector,
  account: AccountView | undefined,
  attempt: Attempt,
  variant: 'connect' | 'settings',
  igConnected: boolean
): { text?: string; tone?: 'muted' | 'destructive' } {
  if (attempt.state === 'connecting') return { text: 'Connecting…' };
  if (attempt.state === 'error') return { text: attempt.message, tone: 'destructive' };
  if (!account) {
    if (igConnected) return { text: 'Connected' };
    return connector.login ? {} : { text: 'Not available yet' };
  }
  switch (account.status) {
    case 'pending':
    case 'resetting':
      return { text: igConnected ? 'Connected · Syncing…' : 'Syncing…' };
    case 'expired':
      return { text: 'Session expired. Reconnect to keep syncing.', tone: 'destructive' };
    case 'error':
      return {
        text: account.lastError ? errorMessage({ error: account.lastError }, connector) : 'Sync failed',
        tone: 'destructive',
      };
    case 'active':
      if (!account.lastSyncedAt) return { text: igConnected ? 'Connected · Syncing…' : 'Syncing…' };
      return { text: variant === 'settings' ? `Connected · Synced ${ago(account.lastSyncedAt)}` : 'Connected' };
  }
}

function pausedLine(state: FunctionReturnType<typeof api.instagram.webview.state>) {
  if (state.killSwitch) return 'Paused · Instagram refreshes are switched off for now.';
  if (state.pausedUntil !== undefined && state.pausedUntil > Date.now()) {
    return `Paused until ${when(state.pausedUntil)}`;
  }
}

function refreshNote(result: RefreshResult | undefined) {
  if (!result) return 'Log in to Instagram in this app to refresh it here.';
  if ('detail' in result) {
    const detail = result.detail;
    if (detail.kind === 'blocked') {
      if (detail.reason === 'paused' && detail.until) return `Paused until ${when(detail.until)}`;
      if (detail.reason === 'not_connected') return 'Log in to Instagram in this app to refresh it here.';
      return 'Paused · Instagram refreshes are switched off for now.';
    }
    if (detail.kind === 'wait') {
      if (detail.reason === 'busy') return 'Already refreshing.';
      if (detail.reason === 'daily_limit') return "Today's refreshes are used up.";
      return `Refreshed recently. Try again at ${when(detail.retryAt)}.`;
    }
    return undefined;
  }
  const counts = `${count(result.posts, 'post')}, ${count(result.stories, 'story', 'stories')}`;
  if (result.outcome === 'done') return `Refreshed · ${counts}`;
  if (result.outcome === 'aborted') return `Refresh stopped early · ${counts}`;
  return "Refresh failed. It'll try again next time you open the app.";
}

function count(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

function when(ms: number) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function ago(ms: number) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}
