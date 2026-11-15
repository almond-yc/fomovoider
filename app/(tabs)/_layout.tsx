import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Wordmark } from '@/components/wordmark';
import { THEME } from '@/lib/theme';
import { Link } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { Settings } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme ?? 'light'];

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']}>
        <View className="h-11 items-center justify-center">
          <Wordmark />
          <Link href="/settings" asChild>
            <Button variant="ghost" size="icon" className="absolute right-2" accessibilityLabel="Settings">
              <Icon as={Settings} size={20} className="text-muted-foreground" />
            </Button>
          </Link>
        </View>
      </SafeAreaView>
      <NativeTabs
        tintColor={theme.foreground}
        iconColor={{ default: theme.mutedForeground, selected: theme.foreground }}
        backgroundColor={theme.background}
        indicatorColor={theme.muted}
        labelVisibilityMode="unlabeled">
        <NativeTabs.Trigger name="index" accessibilityLabel="Feed">
          <NativeTabs.Trigger.Icon sf={{ default: 'newspaper', selected: 'newspaper.fill' }} md="newspaper" />
          <NativeTabs.Trigger.Label hidden />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="chats" accessibilityLabel="Chat">
          <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }} md="chat_bubble" />
          <NativeTabs.Trigger.Label hidden />
        </NativeTabs.Trigger>
      </NativeTabs>
    </View>
  );
}
