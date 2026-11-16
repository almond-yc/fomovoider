// TEMPORARY, not committed: drives the FOMO-32 live test in the simulator.
import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef } from "react";
import { useInstagramWebView } from "./InstagramWebViewHost";

export function InstagramLiveTest() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const ig = useInstagramWebView();
  const state = useQuery(api.instagram.webview.state, isAuthenticated ? {} : "skip");
  const asked = useRef(false);
  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    const creds = { email: "igtest@fomovoider.local", password: "igtest-local-password-1" };
    void signIn("password", { ...creds, flow: "signUp" }).catch(() => signIn("password", { ...creds, flow: "signIn" }));
  }, [isLoading, isAuthenticated, signIn]);
  useEffect(() => {
    if (state && !state.connected && !asked.current) {
      asked.current = true;
      ig.showLogin();
    }
  }, [state, ig]);
  useEffect(() => {
    if (ig.lastRefresh) console.log("IG_REFRESH_RESULT " + JSON.stringify(ig.lastRefresh));
  }, [ig.lastRefresh]);
  return null;
}
