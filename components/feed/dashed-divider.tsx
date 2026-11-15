import { View } from 'react-native';

export function DashedDivider() {
  return (
    <View className="mx-5 h-px overflow-hidden">
      <View className="h-0.5 border border-dashed border-foreground/20" />
    </View>
  );
}
