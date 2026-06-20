/**
 * Config plugin: set android:resizeableActivity="false" on the MainActivity
 * to suppress the Android 16 "Resizability and orientation restrictions"
 * Play Store warning.
 *
 * This explicitly declares phone-only intent. Foldables and large-screen
 * devices will respect the orientation lock instead of ignoring it.
 *
 * Why a custom plugin: as of Expo SDK 54, the `expo.android.resizeableActivity`
 * app.json field is documented but does NOT propagate into the generated
 * AndroidManifest.xml during prebuild (verified 2026-06-20). Until that lands
 * in expo-cli, this plugin is the supported workaround per Expo docs
 * (https://docs.expo.dev/config-plugins/development-and-debugging/).
 *
 * Source-of-truth: `app.json > expo > plugins > "./plugins/withResizeableActivity"`.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

module.exports = function withResizeableActivity(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) return cfg;
    const mainActivity = (application.activity ?? []).find(
      (a) => a.$?.['android:name'] === '.MainActivity',
    );
    if (!mainActivity) return cfg;
    mainActivity.$['android:resizeableActivity'] = 'false';
    // Ensure xmlns:android is present at root (it is by default, defensive only).
    if (!cfg.modResults.manifest.$?.['xmlns:android']) {
      cfg.modResults.manifest.$ = {
        ...(cfg.modResults.manifest.$ ?? {}),
        'xmlns:android': ANDROID_NS,
      };
    }
    return cfg;
  });
};
