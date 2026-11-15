import { Icon } from '@/components/ui/icon';
import { THEME } from '@/lib/theme';
import { Tabs } from 'expo-router';
import { MessageCircle, Newspaper } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

// NativeTabs renders its tab list at the top on web, over the root header,
// so web uses a plain bottom tab bar. Native uses _layout.tsx.
export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const theme = THEME[colorScheme ?? 'light'];

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.foreground,
        tabBarInactiveTintColor: theme.mutedForeground,
        tabBarShowLabel: false,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color, size }) => <Icon as={Newspaper} color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => <Icon as={MessageCircle} color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
