import { ContentItem, ContentItemSkeleton, DashedDivider } from '@/components/feed';
import { samplePosts } from '@/components/feed/sample-posts';
import { useEffect, useState } from 'react';
import { FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function FeedPreviewScreen() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SafeAreaView className="flex-1 bg-background">
      {loading ? (
        <FlatList
          data={[0, 1, 2]}
          keyExtractor={String}
          renderItem={({ index }) => <ContentItemSkeleton withMedia={index === 0} />}
          ItemSeparatorComponent={DashedDivider}
        />
      ) : (
        <FlatList
          data={samplePosts}
          keyExtractor={(post) => post.id}
          renderItem={({ item }) => <ContentItem post={item} />}
          ItemSeparatorComponent={DashedDivider}
        />
      )}
    </SafeAreaView>
  );
}
