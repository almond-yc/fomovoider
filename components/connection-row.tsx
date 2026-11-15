import { PlatformRow } from '@/components/platform-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import {
  errorMessage,
  isMissingFunction,
  PairingCancelled,
  type ClientConnector,
  type PairingCode,
} from '@/lib/connectors';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

export type AccountView = NonNullable<FunctionReturnType<typeof api.users.viewer>>['accounts'][number];

type Attempt =
  | { state: 'idle' }
  | { state: 'connecting'; device: boolean }
  | { state: 'pairing'; pairing: PairingCode }
  | { state: 'error'; message: string };

// A platform row that connects through the connector registry. "connect" is
// the Connect screen; "settings" adds the handle, last sync, Sync now and
// Disconnect.
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
  const [attempt, setAttempt] = useState<Attempt>({ state: 'idle' });
  const [note, setNote] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function connect() {
    if (!connector.login) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setNote(undefined);
    try {
      const login = connector.login({
        convex,
        signal: controller.signal,
        onPairingCode: (pairing) => setAttempt({ state: 'pairing', pairing }),
      });
      setAttempt({ state: 'connecting', device: login.kind === 'device' });
      if (login.kind === 'server') {
        await login.login();
      } else {
        let session;
        if (login.kind === 'oauth') session = await login.login();
        else if (login.kind === 'device') session = await login.pair();
        else throw new Error('Web sign-in is not supported yet.');
        await convex.mutation(api.accounts.connect, { session });
        const started = connector.sync ? await convex.mutation(connector.sync, {}) : true;
        if (started === false) setNote("The first sync couldn't start yet. Tap Sync now in a few minutes.");
      }
      setAttempt({ state: 'idle' });
    } catch (err) {
      if (err instanceof PairingCancelled) setAttempt({ state: 'idle' });
      else setAttempt({ state: 'error', message: errorMessage(err, connector) });
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

  const busy = attempt.state === 'connecting' || attempt.state === 'pairing';
  const broken = account?.status === 'expired' || account?.status === 'error';
  const status = describe(connector, account, attempt, variant);

  let action;
  if (busy) {
    action =
      attempt.state === 'pairing' ? (
        <Button variant="outline" size="sm" onPress={() => abort.current?.abort()}>
          <Text>Cancel</Text>
        </Button>
      ) : (
        <ActivityIndicator className="px-4" />
      );
  } else if (variant === 'settings' && account) {
    action = (
      <Button variant="outline" size="sm" onPress={disconnect}>
        <Text>Disconnect</Text>
      </Button>
    );
  } else if (!account || broken) {
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
    if (variant === 'connect') links.push({ label: 'Disconnect', onPress: disconnect });
  }

  return (
    <PlatformRow
      platform={connector.platform}
      name={connector.name}
      subtitle={variant === 'settings' && account?.me ? `@${account.me.handle}` : connector.description}
      status={note ?? status.text}
      statusTone={status.tone}
      action={action}>
      {attempt.state === 'pairing' || (attempt.state === 'connecting' && attempt.device) ? (
        <PairingStep pairing={attempt.state === 'pairing' ? attempt.pairing : undefined} />
      ) : null}
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

function PairingStep({ pairing }: { pairing?: PairingCode }) {
  return (
    <View className="ml-[60px] mt-3 gap-1.5 rounded-md bg-muted px-4 py-3">
      <Text className="font-sans-medium text-sm">Pair a device</Text>
      {pairing ? (
        <>
          <Text className="font-sans-semibold text-2xl tracking-[4px]" selectable>
            {pairing.code}
          </Text>
          <Text variant="muted">
            Enter this code in the Fomovoider agent on your Mac. It expires at{' '}
            {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </Text>
        </>
      ) : (
        <Text variant="muted">Getting a pairing code…</Text>
      )}
    </View>
  );
}

function describe(
  connector: ClientConnector,
  account: AccountView | undefined,
  attempt: Attempt,
  variant: 'connect' | 'settings'
): { text?: string; tone?: 'muted' | 'destructive' } {
  if (attempt.state === 'connecting' && !attempt.device) return { text: 'Connecting…' };
  if (attempt.state === 'pairing') return { text: 'Waiting for your device…' };
  if (attempt.state === 'error') return { text: attempt.message, tone: 'destructive' };
  if (!account) return connector.login ? {} : { text: 'Not available yet' };
  switch (account.status) {
    case 'pending':
    case 'resetting':
      return { text: 'Syncing…' };
    case 'expired':
      return { text: 'Session expired. Reconnect to keep syncing.', tone: 'destructive' };
    case 'error':
      return {
        text: account.lastError ? errorMessage({ error: account.lastError }, connector) : 'Sync failed',
        tone: 'destructive',
      };
    case 'active':
      if (!account.lastSyncedAt) return { text: 'Syncing…' };
      return { text: variant === 'settings' ? `Connected · Synced ${ago(account.lastSyncedAt)}` : 'Connected' };
  }
}

function ago(ms: number) {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}
