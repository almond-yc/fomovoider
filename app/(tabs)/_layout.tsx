import { THEME } from '@/lib/theme';
import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'nativewind';

// The header (title and Settings button) is the root stack's native header;
// see the (tabs) screen in app/_layout.tsx.
export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme ?? 'light'];

  return (
    <NativeTabs
      tintColor={theme.foreground}
      iconColor={{ default: theme.mutedForeground, selected: theme.foreground }}
      backgroundColor={theme.background}
      indicatorColor={theme.muted}
      labelVisibilityMode="unlabeled">
      <NativeTabs.Trigger name="index" accessibilityLabel="Feed">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
        <NativeTabs.Trigger.Label hidden />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats" accessibilityLabel="Chat">
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }} md="chat_bubble" />
        <NativeTabs.Trigger.Label hidden />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
