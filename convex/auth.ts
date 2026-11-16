// Google and Apple are disabled until OAuth credentials exist; uncomment these
// and the providers below to re-enable them (convex/README.md, "Sign-in").
// import Apple from "@auth/core/providers/apple";
// import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, createAccount } from "@convex-dev/auth/server";

// The Anonymous provider, refused unless the deployment sets
// AUTH_ANONYMOUS_ENABLED=true (dev and review only). See convex/README.md, "Sign-in".
const DevAnonymous = ConvexCredentials({
  id: "anonymous",
  authorize: async (_params, ctx) => {
    if (process.env.AUTH_ANONYMOUS_ENABLED !== "true") {
      throw new Error("Anonymous sign-in is disabled");
    }
    const { user } = await createAccount(ctx, {
      provider: "anonymous",
      account: { id: crypto.randomUUID() },
      profile: { isAnonymous: true },
    });
    return { userId: user._id };
  },
});

// Native builds finish OAuth in the app (fomovoider://); web finishes on
// SITE_URL. Expo Go's exp:// can point at any host, so it is accepted only on
// dev deployments that set AUTH_ALLOW_EXPO_GO=true.
export function isAllowedRedirect(redirectTo: string, siteUrl: string, allowExpoGo: boolean) {
  if (redirectTo.startsWith("fomovoider://")) return true;
  if (redirectTo.startsWith("exp://")) return allowExpoGo;
  const base = siteUrl.replace(/\/$/, "");
  if (!redirectTo.startsWith(base)) return false;
  const after = redirectTo[base.length];
  return after === undefined || after === "/" || after === "?";
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    // Email and password, with no email verification yet.
    Password,
    // Disabled until OAuth credentials exist (see the imports above).
    // Google,
    // Apple({
    //   // Apple shares the name only on the first sign-in, and its default
    //   // profile sets image: null, which the users table rejects.
    //   profile: (appleInfo) => ({
    //     id: appleInfo.sub,
    //     name: appleInfo.user
    //       ? `${appleInfo.user.name.firstName} ${appleInfo.user.name.lastName}`
    //       : undefined,
    //     email: appleInfo.email,
    //   }),
    // }),
    DevAnonymous,
  ],
  callbacks: {
    async redirect({ redirectTo }) {
      const siteUrl = process.env.SITE_URL;
      if (!siteUrl) throw new Error("SITE_URL is not set");
      if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) {
        return `${siteUrl.replace(/\/$/, "")}${redirectTo}`;
      }
      if (!isAllowedRedirect(redirectTo, siteUrl, process.env.AUTH_ALLOW_EXPO_GO === "true")) {
        throw new Error(`Invalid redirectTo ${redirectTo}`);
      }
      return redirectTo;
    },
  },
});
