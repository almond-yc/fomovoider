import VoicePill from '@/components/voice-pill';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api } from '@/convex/_generated/api';
import { MAX_SLOP_DESCRIPTION_LENGTH } from '@/convex/lib/validators';
import { THEME } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { useMutation } from 'convex/react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Mic, Square } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

// Speech recognition is on-device; hide the mic when the platform has none.
function canDictate() {
  try {
    return (
      ExpoSpeechRecognitionModule.isRecognitionAvailable() && ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()
    );
  } catch {
    return false;
  }
}

// The onboarding question, also opened prefilled from the Feed header to edit. The answer can be typed or
// dictated: on-device speech recognition streams into the field and its volume drives the voice-glow pill.
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
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [micDenied, setMicDenied] = useState(false);
  const [micAvailable] = useState(canDictate);
  const dictationBase = useRef('');
  const dictating = useRef(false);
  const mounted = useRef(true);
  const canSubmit = value.trim() !== '' && !saving;

  useSpeechRecognitionEvent('result', (event) => {
    if (!dictating.current) return;
    const spoken = event.results[0]?.transcript ?? '';
    const next = (dictationBase.current + spoken).slice(0, MAX_SLOP_DESCRIPTION_LENGTH);
    setValue(next);
    if (event.isFinal) dictationBase.current = `${next.trimEnd()} `;
  });
  useSpeechRecognitionEvent('volumechange', (event) => setLevel(Math.min(1, Math.max(0, event.value / 10))));
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    setLevel(0);
  });
  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    setLevel(0);
    if (event.error === 'not-allowed') setMicDenied(true);
  });

  useEffect(
    () => () => {
      mounted.current = false;
      dictating.current = false;
      ExpoSpeechRecognitionModule.abort();
    },
    []
  );

  function onChangeText(text: string) {
    if (listening) {
      dictating.current = false;
      ExpoSpeechRecognitionModule.stop();
    }
    setValue(text);
  }

  async function toggleListening() {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setMicDenied(true);
      return;
    }
    if (!mounted.current) return;
    Keyboard.dismiss();
    dictationBase.current = value.trim() === '' ? '' : `${value.trimEnd()} `;
    dictating.current = true;
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      requiresOnDeviceRecognition: true,
      interimResults: true,
      continuous: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    });
  }

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
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
          onChangeText={onChangeText}
          multiline
          autoFocus
          maxLength={MAX_SLOP_DESCRIPTION_LENGTH}
          textAlignVertical="top"
          placeholder="In your own words"
          placeholderTextColor={theme.mutedForeground}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={cn(
            'mt-3 min-h-40 rounded-xl border bg-background p-4 font-sans text-base leading-6 text-foreground',
            focused ? 'border-ring' : 'border-input',
            Platform.select({ web: 'outline-none' })
          )}
        />
        {value.length > MAX_SLOP_DESCRIPTION_LENGTH * 0.8 && (
          <Text variant="muted" className="text-right text-xs">
            {value.length}/{MAX_SLOP_DESCRIPTION_LENGTH}
          </Text>
        )}
      </ScrollView>
      <View className="gap-3 px-6 pb-6 pt-2">
        {micAvailable && !micDenied && (
          <View className="h-14 flex-row items-center gap-3">
            <View className="h-14 flex-1">
              {listening && (
                <VoicePill
                  dom={{ style: { flex: 1, backgroundColor: 'transparent' } }}
                  level={level}
                  active={listening}
                  dark={colorScheme === 'dark'}
                  label="Listening…"
                />
              )}
              {!listening && (
                <Text variant="muted" className="flex-1 pt-4 text-sm">
                  Or tap the mic and say it.
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={listening ? 'Stop dictation' : 'Answer with your voice'}
              onPress={toggleListening}
              className={cn(
                'size-12 items-center justify-center rounded-full active:opacity-80',
                listening ? 'bg-destructive' : 'border border-input bg-background'
              )}>
              <Icon as={listening ? Square : Mic} size={20} color={listening ? '#fff' : theme.foreground} />
            </Pressable>
          </View>
        )}
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
