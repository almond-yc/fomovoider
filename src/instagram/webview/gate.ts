// The hidden web view's only navigation gate. The host sets originWhitelist
// to ["*"] so react-native-webview never hands a URL to Linking.openURL
// (which is how instagram:// and App Store links used to leave the app),
// and every frame navigation lands here instead. Refusals are silent.
//
// The top frame stays on https://www.instagram.com. Frames inside it
// (reCAPTCHA, Facebook login sync) may load any https page: only the top
// frame can hand off to another app. New windows (window.open,
// target=_blank) never reach this gate; the host drops them in onOpenWindow.

export const INSTAGRAM_ORIGIN = "https://www.instagram.com";

export function allowNavigation(req: { url: string; isTopFrame?: boolean }) {
  if (req.url === "about:blank") return true;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (req.isTopFrame === false) return url.protocol === "https:" || url.protocol === "about:";
  return url.origin === INSTAGRAM_ORIGIN;
}
