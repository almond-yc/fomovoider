import { api } from '@/convex/_generated/api';
import type { ConnectorError, Login, PlatformId } from '@/src/connectors/types';
import { createXLogin } from '@/src/connectors/x/login';
import type { ConvexReactClient } from 'convex/react';
import { ConvexError } from 'convex/values';
import { makeFunctionReference, type FunctionReference } from 'convex/server';

export interface PairingCode {
  code: string;
  expiresAt: number;
}

// A login that finishes on the server, which stores, verifies and syncs the
// account itself; login() resolves once that is done.
export interface ServerLogin {
  kind: 'server';
  login(): Promise<unknown>;
}

export interface LoginContext {
  convex: ConvexReactClient;
  signal: AbortSignal;
  onPairingCode: (pairing: PairingCode) => void;
}

// The app's side of a connector: how to show it and how to connect it. The
// Connect screen and Settings render one row per entry, in this order.
export interface ClientConnector {
  platform: PlatformId;
  name: string;
  description: string;
  // Unset when this build can't connect the platform; the row is disabled.
  // A contract Login's Session is stored by the app with accounts.connect,
  // which then starts the first sync.
  login?: (ctx: LoginContext) => Login | ServerLogin;
  // Public mutation (no args) that syncs the signed-in user's account now.
  sync?: FunctionReference<'mutation', 'public', Record<string, never>, unknown>;
  // Public mutation (no args) the platform runs before accounts.disconnect.
  disconnect?: FunctionReference<'mutation', 'public', Record<string, never>, unknown>;
}

const xClientId = process.env.EXPO_PUBLIC_X_CLIENT_ID;

// convex/instagram/devices.ts (FOMO-17). Referenced by name so the build
// doesn't depend on it; until it is deployed the calls fail with a missing
// function error, which the row shows as "not available yet".
interface InstagramDeviceStatus {
  name: string;
  paired: boolean;
  deviceId?: string;
  pausedUntil?: number;
  pauseReason?: string;
}
const instagramDevices = {
  pair: makeFunctionReference<'mutation', { name?: string; timezone?: string }, PairingCode>(
    'instagram/devices:pair'
  ),
  status: makeFunctionReference<'query', Record<string, never>, InstagramDeviceStatus | null>(
    'instagram/devices:status'
  ),
  runNow: makeFunctionReference<'mutation', Record<string, never>, string>('instagram/devices:runNow'),
  disconnect: makeFunctionReference<'mutation', Record<string, never>, null>(
    'instagram/devices:disconnect'
  ),
};

export const connectors: ClientConnector[] = [
  {
    platform: 'x',
    name: 'Twitter',
    description: 'Your timeline, mentions and DMs',
    // The X app is a confidential client: the device runs PKCE and
    // api.x.auth.connect exchanges the code, stores and verifies the session,
    // and starts the first sync.
    login: xClientId
      ? ({ convex }) => ({
          kind: 'server',
          login: createXLogin({
            clientId: xClientId,
            exchange: (code) => convex.action(api.x.auth.connect, code),
          }).login,
        })
      : undefined,
    sync: api.x.sync.requestSync,
  },
  {
    platform: 'instagram',
    name: 'Instagram',
    description: 'Posts and stories through a paired device',
    login: ({ convex, signal, onPairingCode }) => ({
      kind: 'device',
      async pair() {
        const pairing = await convex.mutation(instagramDevices.pair, {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        onPairingCode(pairing);
        const deviceId = await waitForPairedDevice(convex, pairing.expiresAt, signal);
        return { platform: 'instagram', kind: 'device', deviceId };
      },
    }),
    sync: instagramDevices.runNow,
    disconnect: instagramDevices.disconnect,
  },
];

function waitForPairedDevice(convex: ConvexReactClient, expiresAt: number, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const watch = convex.watchQuery(instagramDevices.status, {});
    const finish = (settle: () => void) => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new PairingCancelled()));
    const timer = setTimeout(
      () => finish(() => reject(new Error('The pairing code expired. Try again.'))),
      Math.max(0, expiresAt - Date.now())
    );
    const unsubscribe = watch.onUpdate(() => {
      let status: InstagramDeviceStatus | null | undefined;
      try {
        status = watch.localQueryResult();
      } catch (err) {
        finish(() => reject(err));
        return;
      }
      if (!status?.paired) return;
      const { deviceId } = status;
      finish(() =>
        deviceId ? resolve(deviceId) : reject(new Error('The paired device has no id yet.'))
      );
    });
    signal.addEventListener('abort', onAbort);
  });
}

export class PairingCancelled extends Error {
  constructor() {
    super('Pairing cancelled');
  }
}

export function isMissingFunction(err: unknown) {
  return err instanceof Error && err.message.includes('Could not find public function');
}

export function errorMessage(err: unknown, connector: ClientConnector) {
  if (isMissingFunction(err)) return `${connector.name} isn't available on this server yet.`;
  if (err instanceof ConvexError && err.data && typeof err.data === 'object' && 'kind' in err.data) {
    err = { error: err.data };
  }
  if (err && typeof err === 'object' && 'error' in err) {
    const error = (err as { error: ConnectorError }).error;
    switch (error.kind) {
      case 'session_expired':
        return 'Session expired. Connect again.';
      case 'rate_limited':
        return `${connector.name} is rate limiting us. Syncing resumes later.`;
      case 'budget_exhausted':
        return connector.platform === 'x'
          ? 'X credits used up. Syncing resumes when they refill.'
          : "Today's sync budget is used up. Syncing resumes tomorrow.";
      case 'network':
        return `Couldn't reach ${connector.name}.`;
      case 'unsupported':
        return `${connector.name} doesn't support that.`;
      case 'platform':
        return error.message;
    }
  }
  if (err instanceof Error) return err.message.replace(/^.*Uncaught Error: /s, '').split('\n')[0];
  return 'Something went wrong.';
}
