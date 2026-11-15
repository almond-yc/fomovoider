import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) throw new Error('EXPO_PUBLIC_CONVEX_URL is not set; see .env.example');

const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });

// Convex Auth waits for the stored token before it reports signed in or out,
// so a keychain failure (an unsigned simulator build has no keychain access)
// would hang the app on the splash screen. Fall back to memory instead.
const memory = new Map<string, string>();
const secureStorage = {
  getItem: (key: string) => SecureStore.getItemAsync(key).catch(() => memory.get(key) ?? null),
  setItem: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value).catch(() => {
      memory.set(key, value);
    }),
  removeItem: (key: string) =>
    SecureStore.deleteItemAsync(key).catch(() => {
      memory.delete(key);
    }),
};

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider
      client={convex}
      storage={Platform.OS === 'android' || Platform.OS === 'ios' ? secureStorage : localStorage}
    >
      {children}
    </ConvexAuthProvider>
  );
}
