import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { MAX_SLOP_DESCRIPTION_LENGTH } from '@/convex/lib/validators';
import { THEME } from '@/lib/theme';
import { useMutation } from 'convex/react';
import { useColorScheme } from 'nativewind';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

// The onboarding question, also opened prefilled from the Feed header to edit.
export function SlopForm({
  initialValue = '',
  submitLabel,
  onSaved,
}: {
  initialValue?: string;
  submitLabel: string;
  onSaved?: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme ?? 'light'];
  const setSlop = useMutation(api.users.setSlop);
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = value.trim() !== '' && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setSlop({ slopDescription: value });
      onSaved?.();
    } catch {
      setError("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-8 pb-4"
        keyboardShouldPersistTaps="handled">
        <Text className="font-title text-3xl" accessibilityRole="header">
          What's slop for you?
        </Text>
        <Text variant="muted" className="text-base leading-6">
          Describe the posts you never want to see. We use your answer to filter your feed.
        </Text>
        <TextInput
          accessibilityLabel="What's slop for you?"
          value={value}
          onChangeText={setValue}
          multiline
          autoFocus
          maxLength={MAX_SLOP_DESCRIPTION_LENGTH}
          textAlignVertical="top"
          placeholder="In your own words"
          placeholderTextColor={theme.mutedForeground}
          className="mt-3 min-h-40 rounded-xl border border-input bg-background p-4 font-sans text-base leading-6 text-foreground"
        />
        {value.length > MAX_SLOP_DESCRIPTION_LENGTH * 0.8 && (
          <Text variant="muted" className="text-right text-xs">
            {value.length}/{MAX_SLOP_DESCRIPTION_LENGTH}
          </Text>
        )}
      </ScrollView>
      <View className="gap-3 px-6 pb-6 pt-2">
        {error && (
          <Text className="text-center text-sm text-destructive" accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          onPress={save}
          className={`h-12 items-center justify-center rounded-xl bg-primary active:opacity-80 ${canSubmit ? '' : 'opacity-40'}`}>
          {saving ? (
            <ActivityIndicator color={theme.primaryForeground} />
          ) : (
            <Text className="font-medium text-primary-foreground">{submitLabel}</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
