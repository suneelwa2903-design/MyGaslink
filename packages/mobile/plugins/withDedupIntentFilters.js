/**
 * Config plugin: dedupe `android.intentFilters` in the RESOLVED Expo
 * config so EAS Update doesn't reject a publish with:
 *
 *     "must NOT have duplicate items"
 *
 * Why: `app.json` declares `android.intentFilters` exactly once (the
 * autoVerify VIEW filter for https://mygaslink.com / www.mygaslink.com).
 * But `expo-router`'s plugin also contributes an intent filter (from
 * `expo.scheme` + the linking config it derives), and it merges its
 * entry into `config.android.intentFilters` WITHOUT deduping against
 * the user-declared one when they overlap. Result: the resolved config
 * ends up with two identical filter objects, which the EAS Update
 * schema validator rejects.
 *
 * The prebuilt AndroidManifest.xml shows only one filter — the CLI
 * dedupes on XML write — so this only affects the JSON-config path
 * that EAS Update consumes. That's why prior workarounds had to strip
 * `android.intentFilters` from app.json right before `eas update`
 * and restore after.
 *
 * How this plugin fixes it: hash each filter object by stable-JSON
 * stringify (sorted keys), keep the first occurrence of each hash,
 * drop later duplicates. Runtime behavior is unchanged — the manifest
 * has only ever contained one filter; we're just aligning the JS
 * config with that reality.
 *
 * Order matters: register this plugin as the LAST entry in
 * app.json's `plugins` array so expo-router (and any other plugin
 * that mutates intentFilters) has already run.
 *
 * NOT using `withAndroidManifest` here — the duplication is in the
 * resolved JS config that EAS ingests, not in the manifest XML. So
 * we mutate `config.android.intentFilters` directly.
 *
 * Verify after adding the plugin:
 *   cd packages/mobile
 *   npx expo config --json | jq '.android.intentFilters | length'
 * Expected: 1.
 *
 * Also verify AndroidManifest.xml still has exactly one autoVerify
 * block (it should be unchanged, since the plugin doesn't touch XML):
 *   npx expo prebuild --clean --platform android --no-install
 *   grep -c 'autoVerify="true"' android/app/src/main/AndroidManifest.xml
 * Expected: 1.
 */

/**
 * Stable JSON stringify with sorted keys, recursive.
 * Guarantees `{a:1,b:2}` and `{b:2,a:1}` produce the same string,
 * so structurally-equal intent-filter objects hash identically
 * regardless of author key order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
    '}'
  );
}

module.exports = function withDedupIntentFilters(config) {
  const filters = config?.android?.intentFilters;
  if (!Array.isArray(filters) || filters.length < 2) return config;

  const seen = new Set();
  const deduped = [];
  for (const filter of filters) {
    const hash = stableStringify(filter);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push(filter);
  }

  if (deduped.length === filters.length) return config;

  return {
    ...config,
    android: {
      ...config.android,
      intentFilters: deduped,
    },
  };
};
