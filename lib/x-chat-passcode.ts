import type { api } from '@/convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import { createContext } from 'react';

type SetPasscodeResult = FunctionReturnType<typeof api.x.chatNode.setPasscode>;
export type SetPasscodeError = Extract<SetPasscodeResult, { ok: false }>['error'];

// Provided by app/_layout.tsx only while the X Chat passcode step of
// onboarding is showing, right after Connect X on the Connect screen. finish()
// ends the step for good, whether the user set a passcode or skipped.
export const XChatOnboardingContext = createContext<{ finish(): void } | null>(null);

// What app/x-chat-passcode.tsx shows when api.x.chatNode.setPasscode fails.
export function passcodeErrorText(error: SetPasscodeError): string {
  switch (error.kind) {
    case 'wrongPasscode':
      if (error.guessesRemaining === undefined) return 'Wrong passcode. Check it and try again.';
      return `Wrong passcode, ${error.guessesRemaining} ${error.guessesRemaining === 1 ? 'try' : 'tries'} left.`;
    case 'notSetUp':
      return "Your X account doesn't have an X Chat passcode yet. Set one in the X app first, then come back here.";
    case 'notConnected':
      return 'Connect X first, then add your X Chat passcode.';
    case 'failed':
      return error.message;
  }
}
