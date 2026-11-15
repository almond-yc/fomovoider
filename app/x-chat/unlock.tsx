import { Text } from "@/components/ui/text";
import { useXChat } from "@/src/xchat";
import { CONSENT_CHECKBOX, CONSENT_POINTS, CONSENT_TITLE } from "@/src/xchat/consent";
import { hasConsented, recordConsent } from "@/src/xchat/passcode-store";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";

// Consent (first time), then the X Chat passcode. The passcode goes straight
// to the on-device engine and is cleared from this screen right after.
export default function UnlockXChatScreen() {
  const chat = useXChat();
  const [consented, setConsented] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState("");

  useEffect(() => {
    void hasConsented().then(setConsented);
  }, []);

  useEffect(() => {
    if (chat.status === "unlocked") router.back();
  }, [chat.status]);

  // Offer Face ID once when the screen opens; a cancelled prompt doesn't reopen.
  const triedBiometrics = useRef(false);
  useEffect(() => {
    if (triedBiometrics.current || !consented || chat.status !== "locked" || !chat.passcodeSaved || !chat.biometricEnabled) return;
    triedBiometrics.current = true;
    void chat.unlockWithBiometrics();
  }, [consented, chat]);

  if (consented === null || chat.status === "loading") {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (!consented) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-6">
        <Text variant="h3">{CONSENT_TITLE}</Text>
        {CONSENT_POINTS.map((point) => (
          <Text key={point} className="leading-6">
            {"\u2022 "}
            {point}
          </Text>
        ))}
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => setChecked((c) => !c)} className="flex-row gap-3">
          <Text className="text-lg">{checked ? "\u2611" : "\u2610"}</Text>
          <Text className="flex-1 leading-6">{CONSENT_CHECKBOX}</Text>
        </Pressable>
        <Pressable
          disabled={!checked}
          onPress={async () => {
            await recordConsent();
            setConsented(true);
          }}
          className={`items-center rounded-lg p-4 ${checked ? "bg-primary" : "bg-muted"}`}>
          <Text className={checked ? "text-primary-foreground font-medium" : "text-muted-foreground"}>Continue</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} className="items-center p-2">
          <Text className="text-muted-foreground">Not now</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const error = chat.error;
  const busy = chat.status === "unlocking";
  return (
    <View className="flex-1 gap-4 bg-background p-6">
      <Text variant="h3">Unlock X Chat</Text>
      <Text className="text-muted-foreground leading-6">Enter the passcode you use for X Chat in the X app. It stays on this phone.</Text>
      <TextInput
        value={pin}
        onChangeText={setPin}
        secureTextEntry
        autoComplete="off"
        autoCorrect={false}
        autoCapitalize="none"
        textContentType="none"
        importantForAutofill="no"
        editable={!busy}
        placeholder="X Chat passcode"
        className="rounded-lg border border-border p-4 text-foreground"
      />
      {error && (
        <Text className="text-destructive leading-6">
          {error.kind === "invalidPin"
            ? error.guessesRemaining === undefined
              ? "Wrong passcode."
              : `Wrong passcode. ${error.guessesRemaining} tries left before X deletes your key backup.${error.guessesRemaining < 5 ? " Stop here and reset your passcode in the X app instead." : ""}`
            : error.message}
        </Text>
      )}
      <Pressable
        disabled={busy || pin.length < 4}
        onPress={async () => {
          const value = pin;
          setPin("");
          await chat.unlock(value);
        }}
        className={`items-center rounded-lg p-4 ${busy || pin.length < 4 ? "bg-muted" : "bg-primary"}`}>
        {busy ? <ActivityIndicator /> : <Text className="text-primary-foreground font-medium">Unlock</Text>}
      </Pressable>
      {chat.passcodeSaved && chat.biometricEnabled && (
        <Pressable onPress={() => void chat.unlockWithBiometrics()} className="items-center p-2">
          <Text className="text-muted-foreground">Unlock with Face ID or fingerprint</Text>
        </Pressable>
      )}
    </View>
  );
}
