import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { StyleSheet, View } from 'react-native';

import type { FeedMedia } from './types';

export function ContentMedia({ media }: { media: FeedMedia }) {
  const aspectRatio =
    media.width && media.height ? media.width / media.height : media.kind === 'video' ? 16 / 9 : 4 / 3;

  return (
    <View className="w-full overflow-hidden rounded-md bg-muted" style={{ aspectRatio }}>
      {media.kind === 'video' ? (
        <ContentVideo url={media.url} />
      ) : (
        <Image
          source={media.url}
          placeholder={media.blurhash ? { blurhash: media.blurhash } : media.previewUrl}
          accessibilityLabel={media.altText}
          contentFit="cover"
          transition={150}
          style={StyleSheet.absoluteFill}
        />
      )}
    </View>
  );
}

function ContentVideo({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = true;
  });

  return <VideoView player={player} nativeControls contentFit="cover" style={StyleSheet.absoluteFill} />;
}
