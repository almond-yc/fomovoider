import { Text } from "@/components/ui/text";
import { api } from "@/convex/_generated/api";
import type { Conversation } from "@/src/connectors/types";
import { useXChatMessages } from "@/src/xchat";
import { usePaginatedQuery } from "convex/react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from "react-native";

// One X Chat conversation, decrypted on this phone.
export default function XChatThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { results } = usePaginatedQuery(api.conversations.list, {}, { initialNumItems: 50 });
  const conversation = (results as Conversation[] | undefined)?.find((c) => c.id === id);
  const chat = useXChatMessages(conversation);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const name = conversation?.title ?? conversation?.participants.map((p) => p.displayName || `@${p.handle}`).join(", ");

  if (!chat) {
    return <Text className="p-6 text-muted-foreground">{conversation ? "Not an X Chat conversation." : "Loading\u2026"}</Text>;
  }
  if (chat.status !== "unlocked") {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
        <Stack.Screen options={{ title: name ?? "" }} />
        <Text className="text-center text-muted-foreground">This chat is encrypted. Unlock X Chat to read it on this phone.</Text>
        <Pressable onPress={() => router.push("/x-chat/unlock")} className="rounded-lg bg-primary px-4 py-2">
          <Text className="text-primary-foreground font-medium">Unlock</Text>
        </Pressable>
      </View>
    );
  }

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await chat.send(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-background" behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: name ?? "" }} />
      {chat.error ? <Text className="p-3 text-destructive text-sm">{chat.error}</Text> : null}
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
