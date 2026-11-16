import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { errorMessage } from '@/lib/connectors';
import { passcodeErrorText, XChatOnboardingContext } from '@/lib/x-chat-passcode';
import { CONSENT_CHECKBOX, CONSENT_POINTS, CONSENT_TITLE } from '@/src/xchat/consent';
import { hasConsented, recordConsent } from '@/src/xchat/passcode-store';
import { useAction } from 'convex/react';
import { router, Stack } from 'expo-router';
import { Square, SquareCheck } from 'lucide-react-native';
import { useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The X Chat passcode: in onboarding right after Connect X (with Skip for
// now, both back to Connect), and from Settings to set, change or re-enter it. The consent comes
// before the first entry on this phone. The passcode only lives in this
// screen's state until it is sent to api.x.chatNode.setPasscode.
export default function XChatPasscodeScreen() {
  const onboardingStep = useContext(XChatOnboardingContext);
  const [onboarding] = useState(onboardingStep !== null);
  const setPasscode = useAction(api.x.chatNode.setPasscode);
  const [consented, setConsented] = useState<boolean>();
  const [agreed, setAgreed] = useState(false);
  const [passcode, setPasscodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    hasConsented().then(setConsented, () => setConsented(false));
  }, []);

  useEffect(() => () => setPasscodeInput(''), []);

  // Finishing the onboarding step returns to Connect, where the user can
  // connect another account or continue into the app.
  useEffect(() => {
    if (onboarding && !onboardingStep) router.replace('/connect');
  }, [onboarding, onboardingStep]);

  function leave() {
    if (onboardingStep) onboardingStep.finish();
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  async function submit() {
    const value = passcode;
    setPasscodeInput('');
    setError(undefined);
    setBusy(true);
    try {
      if (!consented) {
        await recordConsent().catch(() => undefined);
        setConsented(true);
      }
      const result = await setPasscode({ passcode: value });
      if (result.ok) return leave();
      setError(passcodeErrorText(result.error));
    } catch (err) {
      setError(errorMessage(err, { platform: 'x', name: 'X', description: '' }));
    } finally {
      setBusy(false);
    }
  }

  if (consented === undefined) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  const canSubmit = !busy && (consented || agreed) && passcode.length >= 4;
  const Container = onboarding ? SafeAreaView : View;

  return (
    <Container className="flex-1 bg-background">
      <Stack.Screen
        options={{
          headerShown: !onboarding,
          title: 'X Chat passcode',
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          headerTitleStyle: { fontFamily: 'Inter_600SemiBold' },
        }}
      />
      <ScrollView
        contentContainerClassName="gap-5 px-6 pb-10 pt-6"
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled">
        <Text className="font-sans-semibold text-xl">{consented ? 'Enter your X Chat passcode' : CONSENT_TITLE}</Text>
        {consented ? (
          <Text variant="muted" className="leading-5">
            The passcode you set for X Chat in the X app.
          </Text>
        ) : (
          <View className="gap-3">
            {CONSENT_POINTS.map((point) => (
              <View key={point} className="flex-row gap-2">
                <Text variant="muted">{'\u2022'}</Text>
                <Text variant="muted" className="flex-1 leading-5">
                  {point}
                </Text>
              </View>
            ))}
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
              onPress={() => setAgreed((a) => !a)}
              className="mt-1 flex-row gap-3">
              <Icon as={agreed ? SquareCheck : Square} size={20} className="text-foreground" />
              <Text className="flex-1 text-sm leading-5">{CONSENT_CHECKBOX}</Text>
            </Pressable>
          </View>
        )}
        <Input
          value={passcode}
          onChangeText={setPasscodeInput}
          secureTextEntry
          autoComplete="off"
          autoCorrect={false}
          autoCapitalize="none"
          textContentType="none"
          importantForAutofill="no"
          editable={!busy}
          placeholder="X Chat passcode"
          accessibilityLabel="X Chat passcode"
          returnKeyType="go"
          onSubmitEditing={() => canSubmit && void submit()}
          className="h-12"
        />
        {error ? (
          <View className="rounded-md bg-muted px-3 py-2.5">
            <Text accessibilityLiveRegion="polite" className="text-sm leading-5">
              {error}
            </Text>
          </View>
        ) : null}
        <Button size="lg" disabled={!canSubmit} onPress={() => void submit()}>
          {busy ? <ActivityIndicator /> : <Text>Continue</Text>}
        </Button>
        {onboarding ? (
          <View className="items-center gap-1">
            <Button variant="link" disabled={busy} onPress={leave}>
              <Text>Skip for now</Text>
            </Button>
            <Text variant="muted" className="text-center text-xs leading-4">
              Encrypted X chats stay locked. You can add the passcode later in Settings.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Container>
  );
}
