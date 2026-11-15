import { XChatProvider } from "@/src/xchat";
import { Stack } from "expo-router";

// The X Chat engine (a hidden WebView) lives only while these screens are
// open, so the passcode and keys leave memory when the user leaves X Chat.
export default function XChatLayout() {
  return (
    <XChatProvider>
      <Stack screenOptions={{ headerShown: true, headerBackTitle: "Back" }}>
        <Stack.Screen name="index" options={{ title: "X Chat" }} />
        <Stack.Screen name="[id]" options={{ title: "" }} />
        <Stack.Screen name="unlock" options={{ title: "Unlock X Chat", presentation: "modal" }} />
        <Stack.Screen name="settings" options={{ title: "X Chat settings" }} />
      </Stack>
    </XChatProvider>
  );
}
