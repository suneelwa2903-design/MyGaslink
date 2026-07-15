/**
 * Config plugin: strip `android.permission.RECORD_AUDIO` from the
 * generated AndroidManifest.xml.
 *
 * Why: expo-camera unconditionally contributes RECORD_AUDIO via its own
 * plugin's manifest merge even when the app only calls takePictureAsync
 * (photos only, no video/audio capture). This is a Play Console warning
 * hotspot (Google explicitly flags apps that request microphone access
 * without a plausible reason) and was raised as a CLAUDE.md v1.1
 * backlog item; proof-of-collection Phase 2 elevates it to mandatory
 * because reinstalling expo-camera re-tacks the permission back on.
 *
 * Order matters: register this plugin AFTER expo-camera in app.json's
 * `plugins` array so expo-camera has already added its uses-permission
 * blocks before this plugin filters them out.
 *
 * Verify after prebuild:
 *   cd packages/mobile
 *   npx expo prebuild --clean --platform android --no-install
 *   grep -c RECORD_AUDIO android/app/src/main/AndroidManifest.xml
 * Expected: 0.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withoutRecordAudio(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults?.manifest;
    if (!manifest) return cfg;

    // uses-permission blocks live under manifest.<uses-permission>, NOT under
    // manifest.application. Filter at that level.
    if (Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (p) => p?.$?.['android:name'] !== 'android.permission.RECORD_AUDIO',
      );
    }

    return cfg;
  });
};
