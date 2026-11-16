import { describe, expect, it } from 'vitest';
import { gate, type GateViewer, type XChatStep } from './onboarding-gate';

const x = { platform: 'x', status: 'active' };
const instagram = { platform: 'instagram', status: 'active' };

function user(accounts: { platform: string; status: string }[], pending = true): GateViewer {
  return { onboardedAt: 1, connectStepPending: pending || undefined, accounts };
}

// Runs the gate the way RootNavigator does: settle the step, then read the screen.
function walk(viewers: GateViewer[], finishAt?: number) {
  let step: XChatStep = 'idle';
  return viewers.map((viewer, i) => {
    if (i === finishAt) step = 'done';
    const result = gate(viewer, step);
    step = result.step;
    return result.screen;
  });
}

describe('gate', () => {
  it('sends signed-out users to sign in and new users to onboarding', () => {
    expect(gate(null, 'idle').screen).toBe('auth');
    expect(gate({ accounts: [] }, 'idle').screen).toBe('onboarding');
    expect(gate(user([]), 'idle').screen).toBe('connect');
  });

  it('returns to Connect after X and its passcode step, then Instagram, until Continue', () => {
    const screens = walk(
      [user([]), user([x]), user([x]), user([x, instagram]), user([x, instagram], false)],
      2,
    );
    expect(screens).toEqual(['connect', 'xChatPasscode', 'connect', 'connect', 'app']);
  });

  it('asks for the X Chat passcode when X comes second', () => {
    const screens = walk([user([]), user([instagram]), user([instagram, x]), user([instagram, x])], 3);
    expect(screens).toEqual(['connect', 'connect', 'xChatPasscode', 'connect']);
  });

  it('enables Continue once one account is active', () => {
    expect(gate(user([]), 'watching').canContinue).toBe(false);
    expect(gate(user([{ platform: 'x', status: 'pending' }]), 'watching').canContinue).toBe(false);
    expect(gate(user([instagram]), 'watching').canContinue).toBe(true);
  });

  it('keeps a user who connected X and restarted the app on Connect, without asking again', () => {
    expect(gate(user([x]), 'idle')).toEqual({ screen: 'connect', step: 'idle', canContinue: true });
  });

  it('sends returning connected users straight to the tabs', () => {
    expect(gate(user([x], false), 'idle')).toEqual({ screen: 'app', step: 'idle', canContinue: true });
    expect(gate(user([instagram], false), 'idle').screen).toBe('app');
  });

  it('never asks from Settings once onboarding is over', () => {
    expect(walk([user([instagram]), user([instagram], false), user([instagram, x], false)])).toEqual([
      'connect',
      'app',
      'app',
    ]);
  });

  it('shows Connect again when every account is gone, and asks once when X comes back', () => {
    const screens = walk([user([], false), user([x], false), user([x], false)], 2);
    expect(screens).toEqual(['connect', 'xChatPasscode', 'app']);
  });

  it('resets the step on sign-out', () => {
    expect(gate(null, 'done').step).toBe('idle');
  });
});
