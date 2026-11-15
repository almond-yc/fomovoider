import '../global.css';
import '@/lib/title-font';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { NAV_THEME, TITLE_FONT } from '@/lib/theme';
import { api } from '@/convex/_generated/api';
import { ConvexClientProvider } from '@/src/providers/ConvexClientProvider';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { ThemeProvider } from 'expo-router/react-navigation';
import { PortalHost } from '@rn-primitives/portal';
import { Link, Stack } from 'expo-router';
import { Settings } from 'lucide-react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useConvexAuth, useQuery } from 'convex/react';
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';
import { Platform } from 'react-native';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme ?? 'light';
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });

  useEffect(() => {
    if (Platform.OS === 'web') document.documentElement.classList.toggle('dark', scheme === 'dark');
  }, [scheme]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <ConvexClientProvider>
      <ThemeProvider value={NAV_THEME[scheme]}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <RootNavigator />
        <PortalHost />
      </ThemeProvider>
    </ConvexClientProvider>
  );
}

// Signed out: sign up or sign in. Signed in with no connected account: the
// Connect screen. Otherwise the tabs and Settings.
function RootNavigator() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : 'skip');
  const ready = !isLoading && (!isAuthenticated || viewer !== undefined);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  const signedIn = isAuthenticated && viewer !== null;
  const connected = viewer?.accounts.some((a) => a.status === 'active') ?? false;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !connected}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && connected}>
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShown: true,
            title: 'Fomovoider',
            headerTitleAlign: 'center',
            headerShadowVisible: false,
            headerTitleStyle: { fontFamily: TITLE_FONT, fontSize: 18 },
            headerRight: () => (
              <Link href="/settings" asChild>
                <Button variant="ghost" size="icon" accessibilityLabel="Settings">
                  <Icon as={Settings} size={20} className="text-muted-foreground" />
                </Button>
              </Link>
            ),
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            headerShown: true,
            title: 'Settings',
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
          }}
        />
        <Stack.Screen name="x-chat" />
      </Stack.Protected>
      <Stack.Screen name="feed-preview" />
    </Stack>
  );
}
