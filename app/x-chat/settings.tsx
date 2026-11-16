import { Text } from "@/components/ui/text";
import { useXChat } from "@/src/xchat";
import { CONSENT_POINTS, CONSENT_TITLE } from "@/src/xchat/consent";
import { router } from "expo-router";
import { Pressable, ScrollView, Switch, View } from "react-native";

// X Chat settings: lock now, and the Face ID / fingerprint unlock switch.
export default function XChatSettingsScreen() {
  const chat = useXChat();
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-6 p-6">
      <Text variant="h3">X Chat</Text>
      <Text className="text-muted-foreground">
        {chat.status === "unlocked" ? "Unlocked on this phone." : "Locked. Encrypted chats show as locked until you unlock."}
      </Text>

      {chat.status === "unlocked" ? (
        <Pressable onPress={() => void chat.lock()} className="items-center rounded-lg border border-border p-4">
          <Text className="font-medium">Lock X Chat now</Text>
        </Pressable>
      ) : (
        <Pressable onPress={() => router.push("/x-chat-passcode")} className="items-center rounded-lg bg-primary p-4">
          <Text className="text-primary-foreground font-medium">Unlock X Chat</Text>
        </Pressable>
      )}

      <View className="flex-row items-center gap-4">
        <View className="flex-1 gap-1">
          <Text className="font-medium">Unlock with Face ID or fingerprint</Text>
          <Text className="text-muted-foreground text-sm leading-5">
            {chat.biometricAvailable
              ? "Keeps your X Chat passcode in this phone's secure storage, behind Face ID or your fingerprint. Turning it off deletes the saved passcode."
              : "This phone has no Face ID or fingerprint set up, so you'll type your passcode after each restart."}
          </Text>
        </View>
        <Switch
          disabled={!chat.biometricAvailable}
          value={chat.biometricAvailable && chat.biometricEnabled}
          onValueChange={(on) => void chat.setBiometricEnabled(on)}
        />
      </View>

      <View className="gap-2">
        <Text className="font-medium">{CONSENT_TITLE}</Text>
        {CONSENT_POINTS.map((point) => (
          <Text key={point} className="text-muted-foreground text-sm leading-5">
            {"\u2022 "}
            {point}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
