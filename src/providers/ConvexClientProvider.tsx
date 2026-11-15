import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import { ConvexReactClient, useConvexAuth } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) throw new Error('EXPO_PUBLIC_CONVEX_URL is not set; see .env.example');

const convex = new ConvexReactClient(url, { unsavedChangesWarning: false });

const secureStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};

// Dev-build identity: sign in anonymously whenever there is no session.
// Replace once the final login method is chosen.
function AnonymousSignIn() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) void signIn('anonymous');
  }, [isLoading, isAuthenticated, signIn]);
  return null;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider
      client={convex}
      storage={Platform.OS === 'android' || Platform.OS === 'ios' ? secureStorage : localStorage}
    >
      <AnonymousSignIn />
      {children}
    </ConvexAuthProvider>
  );
}
