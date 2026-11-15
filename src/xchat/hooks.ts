import { api } from "@/convex/_generated/api";
import { useAction, useConvex, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, Message, Person } from "../connectors/types";
import { type ChatEventRow, type ChatKeyContext, type ChatSendPayload, type DecryptOutcome, chatMessages, unlockedConversation } from "../connectors/x/chat";
import { useXChat } from "./XChatProvider";

const PREVIEWS = 10;
const PREVIEW_EVENTS = 2;

export function isLockedXChat(conversation: Conversation | undefined | null): boolean {
  return conversation?.platform === "x" && conversation.unavailable?.reason === "locked";
}

function peopleOf(conversation: Conversation, me: Person | undefined): Map<string, Person> {
  const people = new Map(conversation.participants.map((p) => [p.id.slice(2), p]));
  if (me) people.set(me.id.slice(2), me);
  return people;
}

function useMe(): Person | undefined {
  const accounts = useQuery(api.accounts.list);
  return accounts?.find((a) => a.platform === "x")?.me as Person | undefined;
}

// Messages of one X Chat conversation, decrypted on this phone. Null for any
// conversation that isn't a locked X Chat row (use the shared messages query).
export function useXChatMessages(conversation: Conversation | undefined | null) {
  const chat = useXChat();
  const me = useMe();
  const locked = isLockedXChat(conversation);
  const conversationId = conversation?.id ?? "";
  const stored = useQuery(api.x.chat.events, locked ? { conversationId } : "skip");
  const fetchEvents = useAction(api.x.chat.fetchEvents);
  const getKeyContext = useAction(api.x.chat.keyContext);
  const sendAction = useAction(api.x.chat.send);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keysLoaded = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!locked) return;
    try {
      await fetchEvents({ conversationId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [locked, fetchEvents, conversationId]);

  useEffect(() => {
    if (locked && chat.status === "unlocked") void refresh();
  }, [locked, chat.status, refresh]);

  useEffect(() => {
    if (!locked || chat.status !== "unlocked" || !stored || !conversation) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    (async () => {
      if (keysLoaded.current !== conversationId) {
        const context: ChatKeyContext = await getKeyContext({ conversationId });
        await chat.addSigningKeys(context.signingKeys);
        keysLoaded.current = conversationId;
      }
      const outcomes = await chat.call<DecryptOutcome[]>({ op: "decrypt", conversationId, rows: stored.rows, keyEvents: stored.keyEvents });
      if (!cancelled) setMessages(chatMessages(stored.rows, outcomes, { conversationId: conversation.id, meId: chat.meId ?? "", people: peopleOf(conversation, me) }));
    })().catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [locked, chat, stored, conversation, conversationId, getKeyContext, me]);

  const send = useCallback(
    async (text: string) => {
      if (!locked || chat.status !== "unlocked") throw new Error("Unlock X Chat to send");
      const payload = await chat.call<ChatSendPayload>({ op: "encrypt", conversationId, text });
      await sendAction({ conversationId, payload });
      await refresh();
    },
    [locked, chat, conversationId, sendAction, refresh],
  );

  return locked ? { status: chat.status, messages, error, send, refresh } : null;
}

// The inbox with X Chat rows filled in once unlocked: the newest few locked
// conversations get their last message decrypted on this phone. Plaintext
// stays in memory; Convex keeps the locked row.
export function useXChatInbox(conversations: Conversation[] | undefined): Conversation[] | undefined {
  const chat = useXChat();
  const me = useMe();
  const convex = useConvex();
  const fetchEvents = useAction(api.x.chat.fetchEvents);
  const getKeyContext = useAction(api.x.chat.keyContext);
  const [previews, setPreviews] = useState<Map<string, Message[]>>(new Map());
  const targets = useMemo(() => (conversations ?? []).filter(isLockedXChat).slice(0, PREVIEWS), [conversations]);
  const targetKey = targets.map((c) => `${c.id}@${c.updatedAt}`).join("|");

  useEffect(() => {
    if (chat.status !== "unlocked") {
      setPreviews(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const next = new Map<string, Message[]>();
      for (const conversation of targets) {
        let stored = await convex.query(api.x.chat.events, { conversationId: conversation.id });
        if (stored && !stored.rows.length) {
          await fetchEvents({ conversationId: conversation.id, limit: PREVIEW_EVENTS }).catch(() => undefined);
          stored = await convex.query(api.x.chat.events, { conversationId: conversation.id });
        }
        if (!stored?.rows.length) continue;
        const context: ChatKeyContext = await getKeyContext({ conversationId: conversation.id });
        await chat.addSigningKeys(context.signingKeys);
        const rows: ChatEventRow[] = stored.rows;
        const outcomes = await chat.call<DecryptOutcome[]>({ op: "decrypt", conversationId: conversation.id, rows, keyEvents: stored.keyEvents });
        next.set(conversation.id, chatMessages(rows, outcomes, { conversationId: conversation.id, meId: chat.meId ?? "", people: peopleOf(conversation, me) }));
        if (cancelled) return;
      }
      if (!cancelled) setPreviews(next);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chat.status, targetKey]);

  return useMemo(
    () => conversations?.map((c) => (previews.has(c.id) ? unlockedConversation(c, previews.get(c.id)!) : c)),
    [conversations, previews],
  );
}
