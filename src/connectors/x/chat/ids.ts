import { ConnectorFailure, type Id } from "../../types";

const ONE_TO_ONE = /^(\d{1,19})-(\d{1,19})$/;
const GROUP = /^g\d{1,19}$/;
const TWITTER_EPOCH_MS = 1288834974657n;

// X Chat and legacy DMs name a 1:1 the same way ("<low>-<high>"), so the
// contract id is shared and the two merge into one Conversation.
export function chatConversationId(xChatId: string): Id {
  const pair = ONE_TO_ONE.exec(xChatId);
  if (pair) {
    const [a, b] = [pair[1]!, pair[2]!].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0));
    return `x:${a}-${b}`;
  }
  if (GROUP.test(xChatId)) return `x:${xChatId}`;
  throw new ConnectorFailure({ kind: "platform", message: `Unrecognized X Chat conversation id: ${xChatId}` });
}

// The path id the chat endpoints take: the other person's user id for a 1:1,
// the group id otherwise.
export function chatTarget(conversationId: Id, meId: string): string {
  if (!conversationId.startsWith("x:")) throw new ConnectorFailure({ kind: "platform", message: `Not an X id: ${conversationId}` });
  const id = conversationId.slice(2);
  if (GROUP.test(id)) return id;
  const pair = ONE_TO_ONE.exec(id);
  if (!pair) throw new ConnectorFailure({ kind: "platform", message: `Not an X Chat conversation: ${conversationId}` });
  const other = pair[1] === meId ? pair[2]! : pair[1]!;
  if (other === meId || (pair[1] !== meId && pair[2] !== meId)) {
    throw new ConnectorFailure({ kind: "platform", message: `${conversationId} is not one of this account's chats` });
  }
  return other;
}

// Milliseconds encoded in an X snowflake id, or undefined for other ids.
export function snowflakeTime(id: string | undefined): number | undefined {
  if (!id || !/^\d{1,19}$/.test(id)) return undefined;
  const ms = Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
  return ms > Number(TWITTER_EPOCH_MS) ? ms : undefined;
}

// Sorts as a string in the same order as the numeric id.
export function eventSortKey(id: string): string {
  return /^\d{1,19}$/.test(id) ? id.padStart(19, "0") : `~${id}`;
}
