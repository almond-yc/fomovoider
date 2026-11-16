'use dom';

import { VoiceBeam } from 'voice-glow';

// Expo DOM component: the voice-glow beam under a "Listening…" pill, driven by the native speech volume.
export default function VoicePill({
  level,
  active,
  dark,
  label,
}: {
  level: number;
  active: boolean;
  dark: boolean;
  label: string;
  dom?: import('expo/dom').DOMProps;
}) {
  return (
    <div
      style={{
        padding: 6,
        boxSizing: 'border-box',
        height: '100vh',
        background: 'transparent',
      }}>
      <VoiceBeam
        type="pill"
        theme={dark ? 'dark' : 'light'}
        level={level}
        active={active}
        idle={0.5}
        style={{ width: '100%' }}>
        <div
          style={{
            height: 44,
            borderRadius: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: '-apple-system, system-ui, sans-serif',
            fontSize: 15,
            color: dark ? '#a3a3a3' : '#737373',
            background: dark ? '#171717' : '#fafafa',
          }}>
          {label}
        </div>
      </VoiceBeam>
    </div>
  );
}
