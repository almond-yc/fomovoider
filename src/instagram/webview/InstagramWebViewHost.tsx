import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { getNetworkStateAsync, NetworkStateType } from "expo-network";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { captureHookJs, FEED_OPERATIONS, type HookMessage } from "../hook";
import { FOLLOWING_URL } from "../navigation";
import { extract, parseResponseText } from "../parse";
import { runRefresh, type PageControl, type RefreshApi, type RefreshResult } from "../refresh";
import { tripwireFor } from "../tripwire";

// The one hidden instagram.com web view in Fomovoider. It holds the user's
// Instagram session (cookies stay in this phone's web view store and never
// reach Convex), shows itself only for the one-time login, and runs
// Instagram work one task at a time so feed refreshes and DM work never
// drive the page at the same time. Mount once inside ConvexClientProvider.
//
// Plug-in API (README.md): pass extra GraphQL operation names in
// `operations` to have their responses captured, listen with
// useInstagramWebView().onMessage, and drive the page only inside
// useInstagramWebView().run(task).

export type InstagramStatus = "off" | "loading" | "needs_login" | "ready";

export type InstagramTask<T> = (page: PageControl) => Promise<T>;

interface InstagramWebViewValue {
  status: InstagramStatus;
  loginVisible: boolean;
  // Opens the visible login screen (Connect). Closes itself once logged in.
  showLogin(): void;
  hideLogin(): void;
  // Runs a task with exclusive use of the page, after any queued ones.
  run<T>(task: InstagramTask<T>): Promise<T>;
  // Every message the capture hook sends (responses, SSR data, locations).
  onMessage(listener: (message: HookMessage) => void): () => void;
  // Settings' "Refresh now". Convex still enforces spacing and the kill switch.
  refreshNow(): Promise<RefreshResult | undefined>;
  lastRefresh?: RefreshResult;
}

const Context = createContext<InstagramWebViewValue | null>(null);

export function useInstagramWebView() {
  const value = useContext(Context);
  if (!value) throw new Error("useInstagramWebView needs an InstagramWebViewHost above it");
  return value;
}

// What Mobile Safari on this iPhone sends; instagram.com serves the full web
// app to it, and bounces WKWebView's default agent to the App Store.
function safariUserAgent() {
  const version = String(Platform.Version || "18.5").split(".");
  const [major, minor = "0"] = version;
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${version.join("_")} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${major}.${minor} Mobile/15E148 Safari/604.1`;
}

const GOTO_TIMEOUT_MS = 20_000;
const EVALUATE_TIMEOUT_MS = 30_000;

export function InstagramWebViewHost({ children, operations = [] }: { children: ReactNode; operations?: string[] }) {
  const { isAuthenticated } = useConvexAuth();
  const state = useQuery(api.instagram.webview.state, isAuthenticated ? {} : "skip");
  const connect = useMutation(api.instagram.webview.connect);
  const startRefresh = useMutation(api.instagram.webview.startRefresh);
  const generateUploadUrl = useMutation(api.instagram.webview.generateUploadUrl);
  const submit = useMutation(api.instagram.webview.submit);
  const finish = useMutation(api.instagram.webview.finish);

  const [loginVisible, setLoginVisible] = useState(false);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [lastRefresh, setLastRefresh] = useState<RefreshResult>();
  const mounted = Boolean(isAuthenticated && (state?.connected || loginVisible));
  const status: InstagramStatus = !mounted ? "off" : loggedIn === null ? "loading" : loggedIn ? "ready" : "needs_login";

  const webview = useRef<WebView<object>>(null);
  const listeners = useRef(new Set<(m: HookMessage) => void>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const busy = useRef(false);
  const results = useRef(new Map<number, (r: { ok: boolean; value: string }) => void>());
  const nextId = useRef(1);
  const loadWaiters = useRef(new Set<(url: string) => void>());
  const killed = useRef(false);
  killed.current = state?.killSwitch ?? false;

  const hookJs = useMemo(() => captureHookJs([...new Set([...FEED_OPERATIONS, ...operations])]), [operations]);

  const onMessage = useCallback((listener: (m: HookMessage) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const page = useMemo<PageControl>(
    () => ({
      goto: (url) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            loadWaiters.current.delete(done);
            reject(new Error(`Timed out loading ${url}`));
          }, GOTO_TIMEOUT_MS);
          const done = () => {
            clearTimeout(timer);
            loadWaiters.current.delete(done);
            resolve();
          };
          loadWaiters.current.add(done);
          webview.current?.injectJavaScript(`location.assign(${JSON.stringify(url)}); true;`);
        }),
      evaluate: <T,>(js: string) =>
        new Promise<T>((resolve, reject) => {
          const id = nextId.current++;
          const timer = setTimeout(() => {
            results.current.delete(id);
            reject(new Error("Page script timed out"));
          }, EVALUATE_TIMEOUT_MS);
          results.current.set(id, ({ ok, value }) => {
            clearTimeout(timer);
            results.current.delete(id);
            if (!ok) return reject(new Error(value));
            resolve(value === undefined || value === "undefined" ? (undefined as T) : (JSON.parse(value) as T));
          });
          const post = (ok: string, v: string) =>
            `window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ig:result", id: ${id}, ok: ${ok}, value: ${v} }))`;
          webview.current?.injectJavaScript(
            `(async function () {\n${js}\n})().then(function (v) { ${post("true", "JSON.stringify(v === undefined ? null : v)")}; }, function (e) { ${post("false", "String(e)")}; }); true;`,
          );
        }),
      onMessage,
    }),
    [onMessage],
  );

  const run = useCallback(
    <T,>(task: InstagramTask<T>): Promise<T> => {
      const next = queue.current.then(async () => {
        busy.current = true;
        try {
          return await task(page);
        } finally {
          busy.current = false;
        }
      });
      queue.current = next.catch(() => undefined);
      return next;
    },
    [page],
  );

  const refresh = useCallback(
    (trigger: "open" | "manual") =>
      run(async (p) => {
        const refreshApi: RefreshApi = {
          startRefresh,
          generateUploadUrl: ({ runId }) => generateUploadUrl({ runId: runId as Id<"instagram_runs"> }),
          submit: ({ runId, items, feedPage }) =>
            submit({
              runId: runId as Id<"instagram_runs">,
              items: items.map((item) => ({
                ...item,
                media: item.media.map((m) => ({ ...m, storageId: m.storageId as Id<"_storage"> | undefined })),
              })),
              feedPage,
            }),
          finish: ({ runId, ...rest }) => finish({ runId: runId as Id<"instagram_runs">, ...rest }),
        };
        const result = await runRefresh(trigger, {
          page: p,
          api: refreshApi,
          uploadFile,
          onWifi: async () => (await getNetworkStateAsync()).type === NetworkStateType.WIFI,
          killed: () => killed.current,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        setLastRefresh(result);
        return result;
      }),
    [run, startRefresh, generateUploadUrl, submit, finish],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: HookMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as HookMessage;
      } catch {
        return;
      }
      if (message.type === "ig:result") return results.current.get(message.id)?.(message);
      if (message.type === "ig:ssr") {
        const viewer = extract(message.scripts.flatMap(parseResponseText)).viewer;
        if (viewer) {
          setLoggedIn(true);
          setLoginVisible(false);
          void connect({ me: viewer, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        }
      }
      if (message.type === "ig:location" && tripwireFor(message.href)?.kind === "login") setLoggedIn(false);
      for (const listener of listeners.current) listener(message);
    },
    [connect],
  );

  // Refresh when the app comes to the foreground; Convex decides whether it
  // is due (startRefresh spacing) and refuses while the kill switch is on.
  useEffect(() => {
    if (status !== "ready" || !state?.connected) return;
    const maybeRefresh = () => {
      if (!busy.current && !killed.current) void refresh("open").catch(() => undefined);
    };
    maybeRefresh();
    const sub = AppState.addEventListener("change", (s) => s === "active" && maybeRefresh());
    return () => sub.remove();
  }, [status, state?.connected, refresh]);

  const value = useMemo<InstagramWebViewValue>(
    () => ({
      status,
      loginVisible,
      showLogin: () => setLoginVisible(true),
      hideLogin: () => setLoginVisible(false),
      run,
      onMessage,
      refreshNow: () => (status === "ready" ? refresh("manual") : Promise.resolve(undefined)),
      lastRefresh,
    }),
    [status, loginVisible, run, onMessage, refresh, lastRefresh],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {mounted && (
        <View style={loginVisible ? styles.login : styles.hidden} pointerEvents={loginVisible ? "auto" : "none"}>
          {loginVisible && (
            <View style={styles.header}>
              <Text style={styles.title}>Log in to Instagram</Text>
              <Pressable onPress={() => setLoginVisible(false)} hitSlop={12}>
                <Text style={styles.close}>Close</Text>
              </Pressable>
            </View>
          )}
          <WebView<object>
            ref={webview}
            source={{ uri: FOLLOWING_URL }}
            userAgent={safariUserAgent()}
            injectedJavaScriptBeforeContentLoaded={hookJs}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly
            onMessage={handleMessage}
            onLoadEnd={(e: { nativeEvent: { url: string } }) => loadWaiters.current.forEach((w) => w(e.nativeEvent.url))}
            onShouldStartLoadWithRequest={(req: { url: string }) => /^https?:/i.test(req.url)}
            setSupportMultipleWindows={false}
            allowsBackForwardNavigationGestures={false}
            sharedCookiesEnabled
            webviewDebuggingEnabled={__DEV__}
            onContentProcessDidTerminate={() => webview.current?.reload()}
          />
        </View>
      )}
    </Context.Provider>
  );
}

// Downloads a capture from Instagram's CDN and uploads it to Convex storage.
async function uploadFile(source: string, uploadUrl: string) {
  try {
    const media = await fetch(source);
    if (!media.ok) return undefined;
    const blob = await media.blob();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { storageId: string }).storageId;
  } catch {
    return undefined;
  }
}

const styles = StyleSheet.create({
  // Full size but invisible: the spike (FOMO-23) found a zero-size or
  // detached web view stops paginating, while a full-size one at opacity 0
  // keeps loading like a visible page.
  hidden: { ...StyleSheet.absoluteFill, opacity: 0, zIndex: -1 },
  login: { ...StyleSheet.absoluteFill, zIndex: 1000, backgroundColor: "#fff", paddingTop: 54 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 17, fontWeight: "600" },
  close: { fontSize: 17, color: "#007aff" },
});
