import { api } from '@/convex/_generated/api';
import type { Id } from '@/convex/_generated/dataModel';
import { useMutation } from 'convex/react';
import { useEffect, useRef } from 'react';
import type { ListViewToken } from 'react-native';

const SEEN_FLUSH_MS = 1500;
const SEEN_BATCH = 100;

// Marks posts seen as they come on screen: collects their ids and sends them
// in one markSeenMany call every SEEN_FLUSH_MS, each post at most once.
export function useSeenBatches(postIdOf: (item: unknown) => Id<'posts'>) {
  const markSeenMany = useMutation(api.postStates.markSeenMany);
  const sent = useRef(new Set<Id<'posts'>>());
  const pending = useRef(new Set<Id<'posts'>>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useRef(() => {});
  flush.current = () => {
    timer.current = undefined;
    const ids = [...pending.current];
    pending.current.clear();
    for (let i = 0; i < ids.length; i += SEEN_BATCH) {
      void markSeenMany({ postIds: ids.slice(i, i + SEEN_BATCH) });
    }
  };

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      flush.current();
    },
    [],
  );

  // FlatList requires the same callback for its whole life.
  return useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    for (const { item, isViewable } of viewableItems) {
      const id = postIdOf(item);
      if (!isViewable || sent.current.has(id)) continue;
      sent.current.add(id);
      pending.current.add(id);
    }
    if (pending.current.size > 0 && timer.current === undefined) {
      timer.current = setTimeout(() => flush.current(), SEEN_FLUSH_MS);
    }
  }).current;
}
