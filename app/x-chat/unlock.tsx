import { Redirect } from "expo-router";

// The X Chat passcode screen is app/x-chat-passcode.tsx (server path).
export default function UnlockXChatScreen() {
  return <Redirect href="/x-chat-passcode" />;
}
