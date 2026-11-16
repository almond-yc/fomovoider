import { api } from '@/convex/_generated/api';
import type { ConnectorError, Login, PlatformId } from '@/src/connectors/types';
import { createXLogin } from '@/src/connectors/x/login';
import type { ConvexReactClient } from 'convex/react';
import { ConvexError } from 'convex/values';
import type { FunctionReference } from 'convex/server';

// How the app connects a platform. The contract's oauth login returns a
// Session the app stores with accounts.connect. A "server" login finishes on
// the server, which stores, verifies and syncs the account itself. A
// "webview" login opens the in-app Instagram web view
// (src/instagram/webview), which connects the account itself once the user
// is logged in; its cookies never leave the phone.
export type ClientLogin = Exclude<Login, { kind: 'device' }> | { kind: 'server'; login(): Promise<unknown> };

export interface LoginContext {
  convex: ConvexReactClient;
}

// The app's side of a connector: how to show it and how to connect it. The
// Connect screen and Settings render one row per entry, in this order.
export interface ClientConnector {
  platform: PlatformId;
  name: string;
  description: string;
  // Unset when this build can't connect the platform; the row is disabled.
  login?: (ctx: LoginContext) => ClientLogin;
  // Public mutation (no args) that syncs the signed-in user's account now.
  sync?: FunctionReference<'mutation', 'public', Record<string, never>, unknown>;
  // Public mutation (no args) the platform runs before accounts.disconnect.
  disconnect?: FunctionReference<'mutation', 'public', Record<string, never>, unknown>;
}

const xClientId = process.env.EXPO_PUBLIC_X_CLIENT_ID;

export const connectors: ClientConnector[] = [
  {
    platform: 'x',
    name: 'Twitter',
    description: 'Timeline, mentions and DMs',
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
    description: 'Posts and stories',
    login: () => ({
      kind: 'webview',
      loginUrl: 'https://www.instagram.com/accounts/login/',
      requiredCookies: ['sessionid'],
    }),
    disconnect: api.instagram.devices.disconnect,
  },
];

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
