import * as SecureStore from "expo-secure-store";

// The X Chat passcode, kept only on this phone, behind Face ID or the
// fingerprint, so the user doesn't retype it after every restart. Nothing
// here syncs to iCloud/Google backups or leaves the device.
const PASSCODE_KEY = "xchat.passcode";
const BIOMETRIC_PREF_KEY = "xchat.biometric";
const CONSENT_KEY = "xchat.consent";

export const CONSENT_VERSION = "2026-11-16-server";

const protectedOptions: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: "Unlock X Chat",
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

export function biometricsAvailable(): boolean {
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

// Off by default (the server path needs no phone unlock); only an explicit
// "on" in Settings enables it for the on-phone path.
export async function biometricPreference(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY)) === "on";
}

export async function setBiometricPreference(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, on ? "on" : "off");
  if (!on) await forgetPasscode();
}

export async function savePasscode(pin: string): Promise<void> {
  await SecureStore.setItemAsync(PASSCODE_KEY, pin, protectedOptions);
  await markPasscodeSaved(true);
}

// Shows the Face ID / fingerprint prompt. Null when nothing is saved or the
// person cancelled.
export async function readPasscode(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(PASSCODE_KEY, protectedOptions);
  } catch {
    return null;
  }
}

export async function hasSavedPasscode(): Promise<boolean> {
  return (await SecureStore.getItemAsync(`${PASSCODE_KEY}.saved`)) === "1";
}

export async function markPasscodeSaved(saved: boolean): Promise<void> {
  if (saved) await SecureStore.setItemAsync(`${PASSCODE_KEY}.saved`, "1");
  else await SecureStore.deleteItemAsync(`${PASSCODE_KEY}.saved`);
}

export async function forgetPasscode(): Promise<void> {
  await SecureStore.deleteItemAsync(PASSCODE_KEY, protectedOptions);
  await markPasscodeSaved(false);
}

export async function hasConsented(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CONSENT_KEY)) === CONSENT_VERSION;
}

export async function recordConsent(): Promise<void> {
  await SecureStore.setItemAsync(CONSENT_KEY, CONSENT_VERSION);
}
