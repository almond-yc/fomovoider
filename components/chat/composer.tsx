import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { ArrowUp } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

// Sends only on a tap of the send button. When blocked is set, the input is
// replaced by why this conversation can't be sent to.
export function Composer({ onSend, blocked }: { onSend: (text: string) => void; blocked?: string }) {
  const [draft, setDraft] = useState('');
  const canSend = draft.trim().length > 0;

  if (blocked) {
    return (
      <View className="border-t border-border px-5 py-4">
        <Text className="text-center text-sm text-muted-foreground">{blocked}</Text>
      </View>
    );
  }

  const send = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft('');
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-border px-3 py-2">
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Message"
        multiline
        accessibilityLabel="Message"
        className="max-h-32 min-h-10 flex-1 rounded-[20px] border border-border bg-background px-4 py-2.5 font-sans text-[15px] text-foreground placeholder:text-muted-foreground"
      />
      <Pressable
        onPress={send}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send"
        className={cn('mb-0.5 size-9 items-center justify-center rounded-full bg-primary', !canSend && 'opacity-30')}>
        <Icon as={ArrowUp} size={18} className="text-primary-foreground" />
      </Pressable>
    </View>
  );
}
