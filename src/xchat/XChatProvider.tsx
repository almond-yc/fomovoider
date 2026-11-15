import { api } from "@/convex/_generated/api";
import { useAction, useQuery } from "convex/react";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ChatKeyContext, ChatSigningKey } from "../connectors/x/chat";
import type { EngineErrorKind } from "./engine/core";
import { type BridgeRequest, type BridgeResponse, READY_ID } from "./engine/protocol";
import {
  biometricPreference,
  biometricsAvailable,
  forgetPasscode,
  hasSavedPasscode,
  readPasscode,
  savePasscode,
  setBiometricPreference,
} from "./passcode-store";

export type XChatStatus = "loading" | "locked" | "unlocking" | "unlocked";

export interface XChatError {
  kind: EngineErrorKind;
  message: string;
  guessesRemaining?: number;
}

type Request = BridgeRequest extends infer R ? (R extends BridgeRequest ? Omit<R, "id"> : never) : never;

export interface XChatContextValue {
  status: XChatStatus;
  error: XChatError | null;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  passcodeSaved: boolean;
  unlock(pin: string): Promise<boolean>;
  unlockWithBiometrics(): Promise<boolean>;
  lock(): Promise<void>;
  setBiometricEnabled(on: boolean): Promise<void>;
  // For the hooks: one engine call, and adding a conversation's public keys.
  call<T>(request: Request): Promise<T>;
  addSigningKeys(keys: ChatSigningKey[]): Promise<void>;
  meId: string | null;
}

const XChatContext = createContext<XChatContextValue | null>(null);

export function useXChat(): XChatContextValue {
  const value = useContext(XChatContext);
  if (!value) throw new Error("useXChat needs <XChatProvider> above it");
  return value;
}

class BridgeFailure extends Error {
  constructor(readonly detail: XChatError) {
    super(detail.message);
  }
}

// Mount once, inside ConvexClientProvider. It hosts the hidden WebView that
// runs X's Chat XDK: the passcode and keys stay in that WebView's memory on
// this phone, and only ciphertext goes to Convex and X.
export function XChatProvider({ children }: { children: ReactNode }) {
  const accounts = useQuery(api.accounts.list);
  const x = accounts?.find((a) => a.platform === "x" && a.status === "active");
  const meId = x?.me?.id.slice(2) ?? null;
  const getKeyContext = useAction(api.x.chat.keyContext);

  const [html, setHtml] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<XChatStatus>("loading");
  const [error, setError] = useState<XChatError | null>(null);
  const [biometricEnabled, setBiometricEnabledState] = useState(true);
  const [passcodeSaved, setPasscodeSaved] = useState(false);
  const biometricAvailable = useMemo(biometricsAvailable, []);

  const webview = useRef<WebView<object>>(null);
  const nextId = useRef(READY_ID + 1);
  const pending = useRef(new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>());
  const signingKeys = useRef(new Map<string, ChatSigningKey>());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [asset] = await Asset.loadAsync(require("../../assets/xchat/engine.html"));
      const text = await new File(asset!.localUri ?? asset!.uri).text();
      if (!cancelled) setHtml(text);
      setBiometricEnabledState(await biometricPreference());
      setPasscodeSaved(await hasSavedPasscode());
    })().catch((err) => setError({ kind: "failed", message: `Couldn't load X Chat: ${String(err)}` }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready) setStatus((s) => (s === "loading" ? "locked" : s));
  }, [ready]);

  const call = useCallback(<T,>(request: Request): Promise<T> => {
    const id = nextId.current++;
    return new Promise<T>((resolve, reject) => {
      pending.current.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const message = JSON.stringify({ ...request, id });
      webview.current?.injectJavaScript(`window.__xchat && window.__xchat.receive(${message}); true;`);
    });
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: BridgeResponse;
    try {
      message = JSON.parse(event.nativeEvent.data) as BridgeResponse;
    } catch {
      return;
    }
    if (message.id === READY_ID) return setReady(true);
    const waiter = pending.current.get(message.id);
    if (!waiter) return;
    pending.current.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new BridgeFailure(message.error));
  }, []);

  const unlockWith = useCallback(
    async (pin: string, fromBiometrics: boolean): Promise<boolean> => {
      if (!ready || !meId) return false;
      setStatus("unlocking");
      setError(null);
      try {
        const context: ChatKeyContext = await getKeyContext({});
        for (const key of context.signingKeys) signingKeys.current.set(`${key.userId}:${key.publicKeyVersion}`, key);
        await call({ op: "unlock", pin, context: { ...context, signingKeys: [...signingKeys.current.values()] } });
        setStatus("unlocked");
        if (!fromBiometrics && biometricAvailable && (await biometricPreference())) {
          await savePasscode(pin);
          setPasscodeSaved(true);
        }
        return true;
      } catch (err) {
        const detail = err instanceof BridgeFailure ? err.detail : { kind: "failed" as const, message: err instanceof Error ? err.message : String(err) };
        // A saved passcode that X now rejects (changed in the X app) must not
        // be retried: every try spends one of the user's 20 guesses.
        if (fromBiometrics && detail.kind === "invalidPin") {
          await forgetPasscode();
          setPasscodeSaved(false);
        }
        setError(detail);
        setStatus("locked");
        return false;
      }
    },
    [ready, meId, getKeyContext, call, biometricAvailable],
  );

  const unlock = useCallback((pin: string) => unlockWith(pin, false), [unlockWith]);

  const unlockWithBiometrics = useCallback(async () => {
    if (!passcodeSaved) return false;
    const pin = await readPasscode();
    return pin ? unlockWith(pin, true) : false;
  }, [passcodeSaved, unlockWith]);

  const lock = useCallback(async () => {
    if (ready) await call({ op: "lock" }).catch(() => undefined);
    setStatus(ready ? "locked" : "loading");
    setError(null);
  }, [ready, call]);

  const setBiometricEnabled = useCallback(async (on: boolean) => {
    await setBiometricPreference(on);
    setBiometricEnabledState(on);
    if (!on) setPasscodeSaved(false);
  }, []);

  const addSigningKeys = useCallback(
    async (keys: ChatSigningKey[]) => {
      for (const key of keys) signingKeys.current.set(`${key.userId}:${key.publicKeyVersion}`, key);
      await call({ op: "setSigningKeys", keys: [...signingKeys.current.values()] });
    },
    [call],
  );

  // Signing out of X, or switching X accounts, locks X Chat.
  const previousMe = useRef(meId);
  useEffect(() => {
    if (previousMe.current && previousMe.current !== meId) {
      void lock();
      void forgetPasscode().then(() => setPasscodeSaved(false));
    }
    previousMe.current = meId;
  }, [meId, lock]);

  const value = useMemo<XChatContextValue>(
    () => ({ status, error, biometricAvailable, biometricEnabled, passcodeSaved, unlock, unlockWithBiometrics, lock, setBiometricEnabled, call, addSigningKeys, meId }),
    [status, error, biometricAvailable, biometricEnabled, passcodeSaved, unlock, unlockWithBiometrics, lock, setBiometricEnabled, call, addSigningKeys, meId],
  );

  return (
    <XChatContext.Provider value={value}>
      {children}
      {html && (
        <View style={{ width: 0, height: 0, position: "absolute", opacity: 0 }} pointerEvents="none">
          <WebView<object>
            ref={webview}
            source={{ html, baseUrl: "" }}
            originWhitelist={["*"]}
            onMessage={onMessage}
            onShouldStartLoadWithRequest={(req: { url: string }) => !/^https?:/i.test(req.url)}
            javaScriptEnabled
            incognito
            cacheEnabled={false}
            webviewDebuggingEnabled={__DEV__}
            setSupportMultipleWindows={false}
            allowFileAccess={false}
            onContentProcessDidTerminate={() => {
              setReady(false);
              setStatus("loading");
              webview.current?.reload();
            }}
          />
        </View>
      )}
    </XChatContext.Provider>
  );
}
