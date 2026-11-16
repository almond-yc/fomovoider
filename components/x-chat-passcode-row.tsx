import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { useMutation, useQuery } from 'convex/react';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

const STATUS_TEXT = {
  none: 'Not set',
  active: 'Active',
  invalid: 'Needs re-entry',
} as const;

// Under the Twitter row in Settings: whether Fomovoider holds the X Chat keys
// that let it read encrypted X chats, with Set or Change and Remove.
export function XChatPasscodeRow() {
  const passcode = useQuery(api.x.chatKeys.passcodeStatus);
  const removePasscode = useMutation(api.x.chatKeys.removePasscode);
  const [note, setNote] = useState<string>();
  if (!passcode) return null;

  function remove() {
    Alert.alert(
      'Remove X Chat passcode?',
      'Fomovoider deletes your saved X Chat keys. Chats already in your inbox stay; new encrypted chats stay locked until you add the passcode again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setNote(undefined);
            removePasscode().catch(() => setNote("Couldn't remove it. Try again."));
          },
        },
      ]
    );
  }

  return (
    <View className="-mt-2 px-5 pb-4">
      <View className="ml-[60px] gap-1">
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="font-sans-medium text-sm">X Chat passcode</Text>
            <Text variant="muted" className="text-xs">
              {note ?? STATUS_TEXT[passcode.status]}
            </Text>
          </View>
          <Button variant="link" size="sm" className="h-auto px-0 py-1" onPress={() => router.push('/x-chat-passcode')}>
            <Text className="text-xs">{passcode.status === 'none' ? 'Set' : 'Change'}</Text>
          </Button>
          {passcode.status !== 'none' ? (
            <Button variant="link" size="sm" className="h-auto px-0 py-1" onPress={remove}>
              <Text className="text-xs">Remove</Text>
            </Button>
          ) : null}
        </View>
        {passcode.status === 'invalid' ? (
          <View className="mt-1 rounded-md bg-muted px-3 py-2">
            <Text className="text-xs leading-4">
              {passcode.reason ?? 'X stopped accepting your saved X Chat keys. Enter your X Chat passcode again.'}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
