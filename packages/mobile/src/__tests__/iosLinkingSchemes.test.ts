/**
 * iOS LSApplicationQueriesSchemes config guard.
 *
 * On iOS 9+ Linking.canOpenURL(scheme) returns false for any scheme not
 * declared in Info.plist > LSApplicationQueriesSchemes — even when an app
 * that handles the scheme IS installed. Without these declarations, our
 * canOpenURL probes (today: DeleteAccountButton's mailto check; future:
 * any tel/sms/etc gates) silently short-circuit to the "no handler" path
 * on real iOS devices, making the App Store reviewer experience strictly
 * worse than the Android equivalent.
 *
 * This test pins the schemes we rely on. Adding a new canOpenURL probe?
 * Extend REQUIRED_SCHEMES below, NOT a comment elsewhere.
 */

import appJson from '../../app.json';

const REQUIRED_SCHEMES = ['mailto', 'tel'] as const;

describe('app.json > expo.ios.infoPlist.LSApplicationQueriesSchemes', () => {
  const schemes = appJson.expo.ios.infoPlist?.LSApplicationQueriesSchemes as
    | string[]
    | undefined;

  it('is declared (array, not undefined)', () => {
    expect(Array.isArray(schemes)).toBe(true);
  });

  it.each(REQUIRED_SCHEMES)('includes %s', (scheme) => {
    expect(schemes).toContain(scheme);
  });

  it('has no duplicates', () => {
    expect(schemes).toBeDefined();
    expect(new Set(schemes)).toHaveProperty('size', schemes!.length);
  });
});
