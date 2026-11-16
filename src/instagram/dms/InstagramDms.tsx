import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import type { PageControl } from "../refresh";
import { useInstagramWebView } from "../webview/InstagramWebViewHost";
import { WEBSOCKET_HOOK_JS } from "./page";
import { DM_OPERATIONS } from "./parse";
import { createDmCapture, deliver, syncInbox, type DmApi, type DmTaskDeps, type SyncTrigger } from "./sync";

// What the host needs for DMs:
//   <InstagramWebViewHost {...DM_HOST_PROPS}><InstagramDms />...</InstagramWebViewHost>
export const DM_HOST_PROPS = { operations: DM_OPERATIONS, scripts: [WEBSOCKET_HOOK_JS] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Instagram DMs through the hidden web view. Renders nothing. While the app
// is open it captures what the page loads and the socket pushes, loads the
// Primary inbox on open (Convex spaces it), and delivers queued sends and
// seen receipts through the page, one at a time with the feed refresh.
export function InstagramDms() {
  const { isAuthenticated } = useConvexAuth();
  const { status, run, onMessage } = useInstagramWebView();
  const state = useQuery(api.instagram.webview.state, isAuthenticated ? {} : "skip");
  const outbox = useQuery(api.instagram.dms.outbox, isAuthenticated && status === "ready" ? {} : "skip");
  const startSync = useMutation(api.instagram.dms.startSync);
  const submit = useMutation(api.instagram.dms.submit);
  const claim = useMutation(api.instagram.dms.claim);
  const complete = useMutation(api.instagram.dms.complete);
  const tripwire = useMutation(api.instagram.dms.tripwire);
  const killed = useRef(false);
  killed.current = state?.killSwitch ?? false;
  const inFlight = useRef(new Set<string>());
  // The connected Instagram handle (meId is instagram:<username>). Nothing
  // is read or sent until the page shows it is logged in as this user.
  const meId = state?.meId;
  const expected = useRef<string | undefined>(undefined);
  expected.current = meId?.startsWith("instagram:") ? meId.slice("instagram:".length) : undefined;
  // Bumped when the Fomovoider user or their Instagram account changes;
  // queued tasks from before then do nothing.
  const generation = useRef(0);

  const dmApi = useMemo<DmApi>(
    () => ({
      startSync,
      submit,
      complete: ({ outboxId, result }) => complete({ outboxId: outboxId as Id<"instagram_outbox">, result }),
      tripwire,
    }),
    [startSync, submit, complete, tripwire],
  );

  const sync = useRef<(trigger: SyncTrigger) => void>(() => undefined);
  const capture = useMemo(
    () => createDmCapture({ api: dmApi, expectedHandle: () => expected.current, onStale: () => sync.current("realtime") }),
    [dmApi],
  );
  const deps = (page: PageControl): DmTaskDeps => ({ page, capture, api: dmApi, killed: () => killed.current, sleep });

  sync.current = (trigger) => {
    if (status !== "ready" || killed.current || !expected.current) return;
    const queued = generation.current;
    void run(async (page) => {
      if (queued === generation.current) await syncInbox(trigger, deps(page));
    }).catch(() => undefined);
  };

  useEffect(() => onMessage(capture.handle), [onMessage, capture]);

  // A different Fomovoider user (or Instagram account): drop what was
  // captured and the work queued for the previous one.
  useEffect(() => {
    generation.current++;
    capture.reset();
    inFlight.current.clear();
  }, [meId, capture]);

  useEffect(() => {
    if (status !== "ready" || !meId) return;
    sync.current("open");
    const sub = AppState.addEventListener("change", (s) => s === "active" && sync.current("open"));
    return () => sub.remove();
  }, [status, meId]);

  useEffect(() => {
    if (status !== "ready" || !meId) return;
    const queued = generation.current;
    for (const { outboxId } of outbox ?? []) {
      if (inFlight.current.has(outboxId)) continue;
      inFlight.current.add(outboxId);
      void run(async (page) => {
        if (queued !== generation.current || !capture.verified()) return;
        const task = await claim({ outboxId });
        if (!task) return;
        const result = await deliver(task, deps(page));
        await complete({ outboxId, result });
      })
        .catch(() => undefined)
        .finally(() => inFlight.current.delete(outboxId));
    }
  }, [outbox, status, meId]);

  return null;
}
