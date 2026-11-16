import type { ConfigContext, ExpoConfig } from "expo/config";

// A free Apple ID signs with its own personal team, and a bundle ID can only
// belong to one team, so each person building to their own iPhone sets
// IOS_BUNDLE_ID (and optionally APPLE_TEAM_ID) in .env.local. See the README,
// "Install on your iPhone".
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.IOS_BUNDLE_ID || config.ios?.bundleIdentifier,
    appleTeamId: process.env.APPLE_TEAM_ID || config.ios?.appleTeamId,
  },
});
