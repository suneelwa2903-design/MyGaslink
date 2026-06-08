/**
 * iOS supportsTablet pin — v1.0 ships iPhone-only.
 *
 * LPG distribution is phone-first (drivers in vehicles, customers at
 * home). No iPad-specific layouts exist today. Shipping iPhone-only
 * avoids:
 *   - iPad-specific layout bugs surfacing during App Store review
 *   - iPad screenshots required in App Store Connect (6.5", 12.9")
 *   - iPad-specific QA cycles before TestFlight
 *
 * If a customer asks for iPad support later (v1.1+):
 *   1. Flip this assertion from .toBe(false) to .toBe(true).
 *   2. Add iPad-specific layout work for screens that need it.
 *   3. Add iPad screenshots to ASC at the 12.9" target.
 *
 * v1.1 backlog item tracked in CLAUDE.md "Post-iOS-submission backlog
 * (Sprint 1)" — "iPad layouts".
 */

import appJson from '../../app.json';

describe('app.json > expo.ios.supportsTablet', () => {
  it('is explicitly false for v1.0 (iPhone-only launch)', () => {
    expect(appJson.expo.ios.supportsTablet).toBe(false);
  });

  it('is a boolean (not undefined — pin the explicit declaration)', () => {
    expect(typeof appJson.expo.ios.supportsTablet).toBe('boolean');
  });
});
