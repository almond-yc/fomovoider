import { describe, expect, it } from 'vitest';
import { passcodeErrorText } from './x-chat-passcode';

describe('passcodeErrorText', () => {
  it('counts the tries X has left', () => {
    expect(passcodeErrorText({ kind: 'wrongPasscode', guessesRemaining: 17 })).toBe('Wrong passcode, 17 tries left.');
    expect(passcodeErrorText({ kind: 'wrongPasscode', guessesRemaining: 1 })).toBe('Wrong passcode, 1 try left.');
  });

  it('says only that the passcode is wrong when X gives no count', () => {
    expect(passcodeErrorText({ kind: 'wrongPasscode' })).toBe('Wrong passcode. Check it and try again.');
  });

  it('sends the user to the X app when no passcode is set up', () => {
    expect(passcodeErrorText({ kind: 'notSetUp' })).toMatch(/Set one in the X app first/);
  });

  it('shows the message of any other failure', () => {
    expect(passcodeErrorText({ kind: 'failed', message: "Couldn't reach X." })).toBe("Couldn't reach X.");
  });
});
