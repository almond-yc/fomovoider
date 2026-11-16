import { Text } from "@/components/ui/text";
import { api } from "@/convex/_generated/api";
import { useXChatMessages } from "@/src/xchat";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";

// TEMPORARY: a stopgap X Chat conversation view for testing. Delete once the
// app's conversation screen uses useXChatMessages (src/xchat/README.md).
export default function XChatThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated } = useConvexAuth();
  const conversation = useQuery(api.x.chat.conversation, isAuthenticated ? { conversationId: id } : "skip");
  const chat = useXChatMessages(conversation);
  const keys = useQuery(api.x.chatKeys.passcodeStatus, isAuthenticated ? {} : "skip");
  const decryptConversation = useAction(api.x.chatNode.decryptConversation);
  const [decrypted, setDecrypted] = useState(false);
  const onServer = keys?.status === "active";
  useEffect(() => {
    if (!onServer || !id) return;
    void decryptConversation({ conversationId: id }).finally(() => setDecrypted(true));
  }, [onServer, id, decryptConversation]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const name = conversation?.title ?? conversation?.participants.map((p) => p.displayName || `@${p.handle}`).join(", ");

  if (onServer) return decrypted ? <Redirect href={{ pathname: "/chat/[id]", params: { id } }} /> : <Text className="p-6 text-muted-foreground">Decrypting\u2026</Text>;
  if (!chat) {
    return <Text className="p-6 text-muted-foreground">{conversation === undefined ? "Loading\u2026" : conversation === null ? "Conversation not found." : "Not an encrypted X Chat conversation."}</Text>;
  }
  if (chat.status !== "unlocked") {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
        <Stack.Screen options={{ title: name ?? "" }} />
        <Text className="text-center text-muted-foreground">This chat is encrypted. Unlock X Chat to read it on this phone.</Text>
        <Pressable onPress={() => router.push("/x-chat-passcode")} className="rounded-lg bg-primary px-4 py-2">
          <Text className="text-primary-foreground font-medium">Unlock</Text>
        </Pressable>
      </View>
    );
  }

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      await chat.send(text);
      setDraft("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: name ?? "" }} />
      {sendError || chat.error ? <Text className="p-3 text-destructive text-sm">{sendError ?? chat.error}</Text> : null}
      <FlatList
        inverted
        data={chat.messages ?? []}
        keyExtractor={(m) => m.id}
        onRefresh={() => void chat.refresh()}
        refreshing={false}
        contentContainerClassName="gap-2 p-4"
        ListEmptyComponent={<Text className="p-6 text-center text-muted-foreground">{chat.messages ? "No messages yet." : "Decrypting\u2026"}</Text>}
        renderItem={({ item }) => (
          <View className={`max-w-[80%] rounded-2xl px-3 py-2 ${item.isMine ? "self-end bg-primary" : "self-start bg-muted"}`}>
            <Text className={item.isMine ? "text-primary-foreground" : ""}>{item.text}</Text>
          </View>
        )}
      />
      <View className="flex-row items-end gap-2 border-t border-border p-3">
        <TextInput value={draft} onChangeText={setDraft} placeholder="Message" multiline className="flex-1 rounded-xl border border-border px-3 py-2 text-foreground" />
        <Pressable disabled={sending || !draft.trim()} onPress={() => void send()} className="rounded-xl bg-primary px-4 py-2 disabled:opacity-50">
          <Text className="text-primary-foreground font-medium">Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
