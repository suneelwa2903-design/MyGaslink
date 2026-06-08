/**
 * Microphone permission guard — Android + iOS app.json declarations only.
 *
 * SCOPE — honest version (was misstated in dd24d68's commit message):
 * This test pins what's in `app.json`. It does NOT reflect AndroidManifest
 * reality. The expo-camera plugin contributes RECORD_AUDIO to the
 * generated AndroidManifest.xml unconditionally (to support video
 * recording), so Android users continue to be prompted for mic access
 * regardless of what app.json says. Verified by `expo prebuild --platform
 * android --no-install --clean` on 2026-06-08 — generated manifest had
 * RECORD_AUDIO at line 8 despite app.json no longer declaring it.
 *
 * What this test still catches:
 * - Someone re-adding RECORD_AUDIO to app.json (a dead duplicate that
 *   reads as if it controls anything but doesn't).
 * - Someone adding NSMicrophoneUsageDescription to iOS without adding
 *   RECORD_AUDIO back to Android's app.json — the lockstep assertion
 *   forces both surfaces to be considered together.
 *
 * What this test does NOT catch:
 * - The fact that expo-camera ships RECORD_AUDIO in the manifest today.
 *   To actually remove the manifest entry, a config plugin tombstone
 *   (Android manifest merge with tools:node="remove") is required.
 *   Tracked as v1.1 backlog if the mic prompt becomes a real concern.
 *
 * If a future feature genuinely uses the mic (e.g. switches to
 * recordAsync), update BOTH surfaces consciously AND flip this test
 * file's assertions from "absent" to "present-on-both" — the lockstep
 * assertion will fail the moment one is added without the other.
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
