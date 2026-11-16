import { Text } from "@/components/ui/text";
import { api } from "@/convex/_generated/api";
import { type InboxConversation, isLockedXChat, useXChat, useXChatInbox } from "@/src/xchat";
import { useAction, useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import { Link, router } from "expo-router";
import { FlatList, Pressable, View } from "react-native";

function title(conversation: InboxConversation): string {
  return conversation.title ?? (conversation.participants.map((p) => p.displayName || `@${p.handle}`).join(", ") || "X Chat");
}

// TEMPORARY: a stopgap X Chat inbox for testing. Delete once the app's Chats
// tab merges X Chat through useXChatInbox (src/xchat/README.md).
export default function XChatInboxScreen() {
  const chat = useXChat();
  const { isAuthenticated } = useConvexAuth();
  const { results, status, loadMore } = usePaginatedQuery(api.conversations.list, isAuthenticated ? {} : "skip", { initialNumItems: 50 });
  const conversations = useXChatInbox(results?.filter(isLockedXChat));
  const keys = useQuery(api.x.chatKeys.passcodeStatus, isAuthenticated ? {} : "skip");
  const decryptConversation = useAction(api.x.chatNode.decryptConversation);
  const onServer = keys?.status === "active";
  const unlocked = onServer || chat.status === "unlocked";
  const open = async (item: InboxConversation) => {
    if (!onServer) return router.push(isLockedXChat(item) && !unlocked ? "/x-chat-passcode" : { pathname: "/x-chat/[id]", params: { id: item.id } });
    if (isLockedXChat(item)) await decryptConversation({ conversationId: item.id });
    router.push({ pathname: "/chat/[id]", params: { id: item.id } });
  };

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between gap-4 border-b border-border p-4">
        <Text className="flex-1 text-muted-foreground text-sm">
          {onServer ? "Decrypted on the server." : unlocked ? "Unlocked on this phone." : "Encrypted chats are locked until you enter your X Chat passcode."}
        </Text>
        {unlocked ? null : (
          <Pressable onPress={() => router.push("/x-chat-passcode")} className="rounded-lg bg-primary px-4 py-2">
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
        onEndReached={() => status === "CanLoadMore" && loadMore(50)}
        ListEmptyComponent={<Text className="p-6 text-center text-muted-foreground">No encrypted X Chat conversations yet.</Text>}
        renderItem={({ item }) => {
          const locked = isLockedXChat(item);
          return (
            <Pressable
              onPress={() => void open(item)}
              className="gap-1 border-b border-border p-4">
              <Text className="font-medium" numberOfLines={1}>
                {title(item)}
              </Text>
              <Text className="text-muted-foreground text-sm" numberOfLines={2}>
                {locked ? (onServer ? "\u{1F512} Encrypted. Tap to decrypt." : "\u{1F512} Encrypted. Unlock X Chat to read.") : (item.lastMessage?.text ?? "")}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
