/**
 * Microphone permission guard — Android + iOS must stay in lockstep.
 *
 * The camera surface is photos-only ([DeliveryProofCamera.tsx] uses
 * takePictureAsync, never recordAsync). Neither platform should declare
 * microphone access. If a future feature genuinely needs the mic, BOTH
 * surfaces must be updated together:
 *   - Android: add "RECORD_AUDIO" to expo.android.permissions
 *   - iOS:     add "NSMicrophoneUsageDescription" to expo.ios.infoPlist
 *
 * Updating one without the other ships a feature that works on one
 * platform and silently fails on the other (iOS will not show the prompt;
 * Android will throw a SecurityException at runtime).
 *
 * This test catches the half-declaration case. It deliberately asserts
 * absence, not presence — the negative pin is the regression guard.
 */

import appJson from '../../app.json';

describe('microphone permissions parity (Android vs iOS)', () => {
  const androidPermissions = appJson.expo.android.permissions as string[];
  const iosInfoPlist = appJson.expo.ios.infoPlist as Record<string, unknown>;

  const declaresAndroidMic = androidPermissions.some((p) =>
    p === 'RECORD_AUDIO' || p === 'android.permission.RECORD_AUDIO',
  );
  const declaresIosMic = 'NSMicrophoneUsageDescription' in iosInfoPlist;

  it('Android does not declare RECORD_AUDIO (camera is photos-only)', () => {
    expect(declaresAndroidMic).toBe(false);
  });

  it('iOS does not declare NSMicrophoneUsageDescription (camera is photos-only)', () => {
    expect(declaresIosMic).toBe(false);
  });

  it('Android and iOS mic declarations are in lockstep', () => {
    expect(declaresAndroidMic).toBe(declaresIosMic);
  });
});
