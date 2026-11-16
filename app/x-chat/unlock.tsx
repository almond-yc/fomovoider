import { Text } from "@/components/ui/text";
import { api } from "@/convex/_generated/api";
import { CONSENT_CHECKBOX, CONSENT_POINTS, CONSENT_TITLE } from "@/src/xchat/consent";
import { passcodeErrorText, type SetPasscodeError } from "@/src/xchat/passcode-errors";
import { useAction, useQuery } from "convex/react";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";

// Consent, then the X Chat passcode, which goes to the server once
// (api.x.chatNode.setPasscode): it checks it with X and keeps only the
// unlocked keys, for every app account linked to this X user. Nothing here
// waits for the on-phone engine.
export default function UnlockXChatScreen() {
  const status = useQuery(api.x.chatKeys.passcodeStatus, {});
  const setPasscode = useAction(api.x.chatNode.setPasscode);
  const [agreed, setAgreed] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SetPasscodeError | null>(null);

  useEffect(() => () => setPin(""), []);

  const active = status?.status === "active";
  const canSubmit = agreed && pin.length >= 4 && !busy;
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-6" keyboardShouldPersistTaps="handled">
      <Text variant="h3">{CONSENT_TITLE}</Text>
      {active && <Text className="text-muted-foreground leading-6">X Chat is on. Enter your passcode again only if X asks for it.</Text>}
      {status?.status === "invalid" && status.reason && <Text className="text-destructive leading-6">{status.reason}</Text>}
      {CONSENT_POINTS.map((point) => (
        <Text key={point} className="leading-6">
          {"\u2022 "}
          {point}
        </Text>
      ))}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} onPress={() => setAgreed((c) => !c)} className="flex-row gap-3">
        <Text className="text-lg">{agreed ? "\u2611" : "\u2610"}</Text>
        <Text className="flex-1 leading-6">{CONSENT_CHECKBOX}</Text>
      </Pressable>
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
      {error && <Text className="text-destructive leading-6">{passcodeErrorText(error)}</Text>}
      <Pressable
        disabled={!canSubmit}
        onPress={async () => {
          const passcode = pin;
          setPin("");
          setError(null);
          setBusy(true);
          try {
            const result = await setPasscode({ passcode });
            if (result.ok) router.back();
            else setError(result.error);
          } catch (err) {
            setError({ kind: "failed", message: err instanceof Error ? err.message : "Something went wrong. Try again." });
          } finally {
            setBusy(false);
          }
        }}
        className={`items-center rounded-lg p-4 ${canSubmit ? "bg-primary" : "bg-muted"}`}>
        {busy ? <ActivityIndicator /> : <Text className={canSubmit ? "text-primary-foreground font-medium" : "text-muted-foreground"}>Continue</Text>}
      </Pressable>
      <Pressable onPress={() => router.back()} className="items-center p-2">
        <Text className="text-muted-foreground">Not now</Text>
      </Pressable>
    </ScrollView>
  );
}
