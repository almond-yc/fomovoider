import '../global.css';
import '@/lib/title-font';

import { ChatProviders } from '@/components/chat';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { NAV_THEME, TITLE_FONT } from '@/lib/theme';
import { api } from '@/convex/_generated/api';
import { gate, type XChatStep } from '@/lib/onboarding-gate';
import { XChatOnboardingContext } from '@/lib/x-chat-passcode';
import { DM_HOST_PROPS, InstagramDms } from '@/src/instagram/dms/InstagramDms';
import { InstagramWebViewHost } from '@/src/instagram/webview/InstagramWebViewHost';
import { ConvexClientProvider } from '@/src/providers/ConvexClientProvider';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { getFocusedRouteNameFromRoute, ThemeProvider } from 'expo-router/react-navigation';
import { PortalHost } from '@rn-primitives/portal';
import { Link, Stack } from 'expo-router';
import { Settings, SlidersHorizontal } from 'lucide-react-native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useConvexAuth, useQuery } from 'convex/react';
import { useColorScheme } from 'nativewind';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

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
        <InstagramWebViewHost {...DM_HOST_PROPS}>
          <InstagramDms />
          <ChatProviders>
            <RootNavigator />
          </ChatProviders>
        </InstagramWebViewHost>
        <PortalHost />
      </ThemeProvider>
    </ConvexClientProvider>
  );
}

// Picks the screen from users.viewer through gate() in lib/onboarding-gate.ts:
// sign up or sign in, onboarding, Connect (with the X Chat passcode step after
// Connect X), then the tabs and Settings.
function RootNavigator() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : 'skip');
  const ready = !isLoading && (!isAuthenticated || viewer !== undefined);
  const [xChatStep, setXChatStep] = useState<XChatStep>('idle');
  const xChatOnboarding = useMemo(() => ({ finish: () => setXChatStep('done') }), []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  const { screen, step } = gate(isAuthenticated ? (viewer ?? null) : null, xChatStep);
  if (step !== xChatStep) setXChatStep(step);
  const signedIn = screen !== 'auth';

  return (
    <XChatOnboardingContext.Provider value={screen === 'xChatPasscode' ? xChatOnboarding : null}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-up" />
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
        <Stack.Protected guard={screen === 'onboarding'}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Protected
          guard={screen === 'connect' || screen === 'app'}
          redirectTo={screen === 'xChatPasscode' ? '/x-chat-passcode' : undefined}>
          <Stack.Screen name="connect" />
        </Stack.Protected>
        <Stack.Protected guard={screen === 'app'}>
          <Stack.Screen
            name="(tabs)"
            options={({ route }) => ({
              headerShown: true,
              title: 'Fomovoider',
              headerTitleAlign: 'center',
              headerShadowVisible: false,
              headerTitleStyle: { fontFamily: TITLE_FONT, fontSize: 18 },
              headerRight: () => <HeaderActions onFeed={(getFocusedRouteNameFromRoute(route) ?? 'index') === 'index'} />,
            })}
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
          <Stack.Screen name="edit-slop" options={{ presentation: 'modal' }} />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="x-chat" />
          <Stack.Screen name="full-feed" />
        </Stack.Protected>
        <Stack.Protected
          guard={screen === 'app' || screen === 'xChatPasscode'}
          redirectTo={screen === 'connect' ? '/connect' : undefined}>
          <Stack.Screen name="x-chat-passcode" />
        </Stack.Protected>
        <Stack.Screen name="feed-preview" />
      </Stack>
    </XChatOnboardingContext.Provider>
  );
}

// On the Feed tab, editing "What's slop for you?" sits next to Settings. The
// tab comes from the (tabs) route, not the URL, so the button stays while the
// edit-slop sheet it opens is on top.
function HeaderActions({ onFeed }: { onFeed: boolean }) {
  return (
    <View className="flex-row">
      {onFeed && (
        <Link href="/edit-slop" asChild>
          <Button variant="ghost" size="icon" accessibilityLabel="Edit what's slop for you">
            <Icon as={SlidersHorizontal} size={20} className="text-muted-foreground" />
          </Button>
        </Link>
      )}
      <Link href="/settings" asChild>
        <Button variant="ghost" size="icon" accessibilityLabel="Settings">
          <Icon as={Settings} size={20} className="text-muted-foreground" />
        </Button>
      </Link>
    </View>
  );
}
