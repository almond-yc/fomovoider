import { Text } from "@/components/ui/text";
import { api } from "@/convex/_generated/api";
import type { Conversation } from "@/src/connectors/types";
import { isLockedXChat, useXChat, useXChatInbox } from "@/src/xchat";
import { usePaginatedQuery } from "convex/react";
import { Link, router } from "expo-router";
import { FlatList, Pressable, View } from "react-native";

function title(conversation: Conversation): string {
  return conversation.title ?? (conversation.participants.map((p) => p.displayName || `@${p.handle}`).join(", ") || "X Chat");
}

// TEMPORARY: a stopgap X Chat inbox for testing. Delete once the app's Chats
// tab merges X Chat through useXChatInbox (src/xchat/README.md).
export default function XChatInboxScreen() {
  const chat = useXChat();
  const { results } = usePaginatedQuery(api.conversations.list, {}, { initialNumItems: 50 });
  const conversations = useXChatInbox(results?.filter((c) => c.platform === "x") as Conversation[] | undefined);
  const unlocked = chat.status === "unlocked";

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between gap-4 border-b border-border p-4">
        <Text className="flex-1 text-muted-foreground text-sm">
          {unlocked ? "Unlocked on this phone." : "Encrypted chats are locked until you unlock X Chat."}
        </Text>
        {unlocked ? null : (
          <Pressable onPress={() => router.push("/x-chat/unlock")} className="rounded-lg bg-primary px-4 py-2">
            <Text className="text-primary-foreground font-medium">Unlock</Text>
          </Pressable>
        )}
        <Link href="/x-chat/settings" className="text-muted-foreground">
          Settings
        </Link>
      </View>
      <FlatList
        data={conversations ?? []}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={<Text className="p-6 text-center text-muted-foreground">No X conversations yet.</Text>}
        renderItem={({ item }) => {
          const locked = isLockedXChat(item);
          return (
            <Pressable
              onPress={() => router.push(locked && !unlocked ? "/x-chat/unlock" : { pathname: "/x-chat/[id]", params: { id: item.id } })}
              className="gap-1 border-b border-border p-4">
              <Text className="font-medium" numberOfLines={1}>
                {title(item)}
              </Text>
              <Text className="text-muted-foreground text-sm" numberOfLines={2}>
                {locked ? "\u{1F512} Encrypted. Unlock X Chat to read." : (item.lastMessage?.text ?? "")}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
