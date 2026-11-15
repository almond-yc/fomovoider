import { XChatProvider } from "@/src/xchat";
import { Stack } from "expo-router";

// X Chat routes. index and [id] are TEMPORARY test screens until the app's
// Chats tab consumes the hooks in src/xchat (see src/xchat/README.md); unlock
// and settings stay. If the app mounts XChatProvider higher up, this one
// reuses it; otherwise the engine lives only while these screens are open.
export default function XChatLayout() {
  return (
    <XChatProvider>
      <Stack screenOptions={{ headerShown: true, headerBackTitle: "Back" }}>
        <Stack.Screen name="index" options={{ title: "X Chat (temporary)" }} />
        <Stack.Screen name="[id]" options={{ title: "" }} />
        <Stack.Screen name="unlock" options={{ title: "Unlock X Chat", presentation: "modal" }} />
        <Stack.Screen name="settings" options={{ title: "X Chat settings" }} />
      </Stack>
    </XChatProvider>
  );
}
