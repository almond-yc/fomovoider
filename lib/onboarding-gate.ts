// The root gate in app/_layout.tsx, as a pure function so it can be tested.
//
// Signed out: sign up or sign in. Signed in without an answer to "What's slop
// for you?": onboarding. Then the Connect screen, until at least one account
// is connected and, for a user still in onboarding (connectStepPending, set
// by users.setSlop and cleared by users.finishConnectStep when they tap
// Continue), until they leave it. Otherwise the tabs and Settings.
//
// XChatStep adds the X Chat passcode step: while the user is on Connect
// without X it watches, when X turns active it asks once, and finish() (set
// or skipped) marks it done, which returns an onboarding user to Connect.
// Users who reach Connect with X already active never get asked here; the
// passcode stays in Settings for them.

export type XChatStep = 'idle' | 'watching' | 'asking' | 'done';

export type GateScreen = 'auth' | 'onboarding' | 'connect' | 'xChatPasscode' | 'app';

export type GateViewer = {
  onboardedAt?: number;
  connectStepPending?: boolean;
  accounts: { platform: string; status: string }[];
} | null;

export function gate(viewer: GateViewer, step: XChatStep): { screen: GateScreen; step: XChatStep; canContinue: boolean } {
  const connected = viewer?.accounts.some((a) => a.status === 'active') ?? false;
  const xConnected = viewer?.accounts.some((a) => a.platform === 'x' && a.status === 'active') ?? false;
  const onboarded = viewer?.onboardedAt !== undefined;
  const connecting = onboarded && (!connected || viewer?.connectStepPending === true);

  let next = viewer === null ? 'idle' : step;
  if (next === 'idle' && connecting && !xConnected) next = 'watching';
  if (next === 'watching') next = xConnected ? 'asking' : connecting ? 'watching' : 'done';

  const screen: GateScreen =
    viewer === null
      ? 'auth'
      : !onboarded
        ? 'onboarding'
        : next === 'asking'
          ? 'xChatPasscode'
          : connecting
            ? 'connect'
            : 'app';
  return { screen, step: next, canContinue: connected };
}
