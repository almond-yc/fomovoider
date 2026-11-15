import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) throw new Error('EXPO_PUBLIC_CONVEX_URL is not set; see .env.example');

const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });

const secureStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
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
