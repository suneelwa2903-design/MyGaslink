# RUNBOOK — SSL Cert Pinning & Rotation (N4)

**Created:** 2026-08-07 · **Owner:** Suneel + Claude sessions · **Feature:** mobile SSL pinning (`plugins/withSslPinning.js`)

---

## 1. What is deployed

The mobile app pins the TLS chain for **`api.mygaslink.com`** at the OS level:

- **Android:** `network_security_config.xml` `<pin-set>` (generated at prebuild by the config plugin; only when `SSL_PINNING=true` — set in `eas.json` for `preview` + `production` profiles).
- **iOS:** `NSPinnedDomains` → `NSPinnedCAIdentities` in Info.plist (same env gate).
- **Dev builds / Expo Go / `development` profile:** never pinned.

### Pin set (SPKI SHA-256, Base64) — verified 2026-08-07

| Pin | Key | Valid until |
|---|---|---|
| `C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=` | ISRG Root X1 | Jun 2035 |
| `diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=` | ISRG Root X2 | Sep 2040 |
| `sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=` | ISRG Root YE | Sep 2032 |

**Why ROOT pins, not leaf:** prod TLS is **Let's Encrypt** (chain observed 2026-08-07: leaf → LE `YE1` intermediate → ISRG Root YE → ISRG Root X2 → ISRG Root X1). LE leaf certs renew every ~60-90 days and **certbot generates a new private key on every renewal by default**, so a leaf pin would brick the app quarterly. All three ISRG root keys are pinned so every current and plausible future LE chain validates. Root pinning still defeats captive portals, corporate SSL-inspection proxies, and any non-LE rogue CA — those present chains anchored outside ISRG.

**Android dead-man switch:** `<pin-set expiration="2027-11-01">` — after this date Android pinning **fails open** (normal CA validation) instead of bricking stale installs. iOS has no equivalent attribute; its safety valve is that the pinned roots are stable to 2032+.

---

## 1b. Verification evidence (2026-08-07, EAS preview build `cc68154e`)

| Check | Method | Result |
|---|---|---|
| Pins match the LIVE prod chain | `openssl s_client -CAfile isrgrootx1.pem -verify_return_error` | ✅ `Verification: OK` (code 0); same for X2 |
| Test discriminates (not rubber-stamping) | same, with an unrelated cert as CA | ✅ fails `code 20 unable to get local issuer` |
| Pins compiled into the SHIPPED artifact | `aapt2 dump xmltree <apk> --file res/8G.xml` | ✅ all 3 ISRG SPKI hashes + `expiration="2027-11-01"` + `api.mygaslink.com` |
| Manifest wires the config | `aapt2 dump xmltree <apk> --file AndroidManifest.xml` | ✅ `android:networkSecurityConfig=@0x7f150003` |
| App installs + launches pinned | emulator `gaslink-test` (Android 14 / API 34) | ✅ login screen renders, process alive, zero TLS errors in logcat |
| **Real HTTPS round-trip through the pin** | in-app sign-in vs prod API with a non-existent account | ✅ **server returned 401 "Invalid email or password"** — proves handshake + pin check + request + response all succeeded |
| Env gating (dev builds unpinned) | `expo prebuild` with and without `SSL_PINNING=true` | ✅ config generated only when the flag is set |

### MITM negative path — VERIFIED 2026-08-07 (no third-party tooling needed)

mitmproxy was **not** required. A self-signed cert (openssl) + a 30-line Node
HTTPS server + an emulator-side `iptables` REDIRECT of the real API IP to that
server reproduces interception exactly, using only tools already on the machine:

```
openssl req -x509 -newkey rsa:2048 -subj "/CN=api.mygaslink.com" ...   # fake cert
node fake-api.js                                                       # 127.0.0.1:8443
adb reverse tcp:8443 tcp:8443
adb shell iptables -t nat -A OUTPUT -p tcp -d <API_IP> --dport 443 -j REDIRECT --to-ports 8443
```

| Observation | Result |
|---|---|
| TLS handshake outcome | ✅ **client aborted** — `tls alert certificate unknown`, SSL alert 46 |
| Requests reaching the impostor | ✅ **0** — no `[INTERCEPTED]` line ever logged; credentials never left the device |
| Repeat attempts | ✅ 5 handshake rejections, 5/5 refused |
| App-visible result | ✅ `Login Failed — Network Error` + offline banner |

This is a **stronger** proof than mitmproxy would give: it isolates the pin
check with no proxy-configuration variables in play.

**Still unconfirmed:** the full-screen "Secure connection blocked" panel
rendering. Its trigger logic (2 consecutive response-less failures → probe the
unpinned origin → block) has 6 dedicated unit tests in `sslPinning.test.ts`,
but emulator UI automation was too flaky to drive the two-attempt sequence
reliably. Confirm opportunistically during real-device testing. **Not a ship
risk** — the protective behaviour (refusing the connection) is proven; only
the cosmetic explanation screen is unconfirmed.

Cleanup after this test (do not leave in place): delete the iptables rule,
`adb reverse --remove-all`, stop the Node server.

---

## 2. Events and what to do

### 2a. Routine Let's Encrypt renewal (~every 60-90 days) — **NO ACTION**
Leaf key changes; chain still anchors to ISRG roots; pins keep matching. Nothing to do, nothing to ship.

### 2b. LE rotates/renames intermediates (e.g. YE1→YE2) — **NO ACTION**
Intermediates are not pinned. As long as the chain tops out at an ISRG root, pins hold.

### 2c. Annual maintenance (calendar: **every August, next 2027-08**) — 15 min
1. Re-run the chain check (section 3) and confirm the served chain still anchors to a pinned ISRG root.
2. Bump the Android `expiration` date in `plugins/withSslPinning.js` (+15 months) in a normal release.
3. Confirm the App Store/Play Store builds in circulation are recent enough that the fail-open date isn't imminent for the oldest supported build.

### 2d. Server moves OFF Let's Encrypt (new CA, e.g. ACM/ZeroSSL) — **ACTION BEFORE CUTOVER**
This is the ONLY infra change that can brick pinned apps. Sequence:
1. Extract the new CA's root SPKI hash(es) (section 3 one-liners).
2. Ship an app release ADDING the new root pins alongside the ISRG pins.
3. Wait until ≥95% of active installs are on that release (Play Console / ASC adoption stats).
4. Only then cut the server over to the new CA.
5. Remove the ISRG pins in a later release once the old chain is gone.
**Never cut the server to a new CA while installed apps only pin ISRG roots.**

### 2e. Suspected mass pin-failure incident (users report "Secure connection blocked" on all networks)
1. Verify from a trusted network: section 3 chain check. If the served chain does NOT anchor to a pinned root → the server cert changed out from under the pins (see 2d — someone cut over without the app release).
2. Broadcast to stranded users: edit `packages/web/public/pinning-status.json` →
   `{ "pinningAdvisory": "incident", "message": "<user-facing text with what to do>" }` and deploy web. The blocked screen in the app displays this message. (OS pins cannot be disabled remotely — this is messaging only.)
3. Fix = either restore the old cert chain server-side (fastest, minutes) OR emergency app release with corrected pins (+expedited review).
4. Android-only comfort: even unfixed, pinning fails open at the `expiration` date.

### 2f. Suneel actions checklist (one-time + recurring)
- [ ] **(one-time)** EAS cloud build on `preview` profile → install APK on a real Android phone → confirm app works normally on mobile data/home Wi-Fi (positive path).
- [ ] **(one-time)** MITM negative test on that same build (section 4). Confirm the "Secure connection blocked" screen appears.
- [ ] **(one-time)** Add UptimeRobot (or similar) HTTPS keyword monitor on `https://api.mygaslink.com/api/health` — alerts on cert errors/changes.
- [ ] **(recurring)** Calendar reminder: **every August 1** → run section 2c maintenance.
- [ ] **(policy)** If anyone ever changes the API's TLS setup (new CA, new host, CDN in front), section 2d MUST run first.

---

## 3. Verification one-liners

Current served chain + SPKI hashes (run in Git Bash):

```bash
echo | openssl s_client -servername api.mygaslink.com -connect api.mygaslink.com:443 -showcerts 2>/dev/null \
  | awk 'BEGIN{n=0} /-----BEGIN CERTIFICATE-----/{n++; inpem=1} inpem{print > ("cert" n ".pem")} /-----END CERTIFICATE-----/{inpem=0}'
for f in cert*.pem; do
  echo "== $f =="; openssl x509 -in "$f" -noout -subject -issuer -dates
  echo -n "SPKI: "; openssl x509 -in "$f" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary | openssl enc -base64
done
```

**Pass condition:** at least one printed SPKI matches a pin in section 1.

Prebuild injection check (after any plugin change):

```bash
cd packages/mobile
SSL_PINNING=true npx expo prebuild --clean --platform android --no-install
cat android/app/src/main/res/xml/network_security_config.xml   # pins present
grep networkSecurityConfig android/app/src/main/AndroidManifest.xml
npx expo prebuild --clean --platform android --no-install       # without env:
ls android/app/src/main/res/xml/network_security_config.xml     # must NOT exist
rm -rf android
```

---

## 4. Real-device MITM negative test (one-time, Suneel)

1. On a laptop on the same Wi-Fi: `pip install mitmproxy` → run `mitmproxy` (default port 8080).
2. On the Android phone with the **preview** build installed: Wi-Fi settings → proxy → manual → laptop IP : 8080.
3. Install the mitmproxy CA on the phone (visit `mitm.it`) — this simulates a corporate/hostile network that users would "trust".
4. Open MyGasLink → try to log in / refresh.
5. **Expected:** requests to `api.mygaslink.com` FAIL, and after ~2 failed calls the app shows the full-screen **"Secure connection blocked"** panel (because `mygaslink.com` probe also goes through the proxy... note: if the probe is ALSO intercepted it fails too and the app shows plain offline — to see the blocked screen specifically, add a mitmproxy ignore rule for `mygaslink.com`: run `mitmproxy --ignore-hosts '^mygaslink\.com:443$'`).
6. Chrome on the same phone CAN browse via the proxy (proves the proxy works and only the pinned app refuses).
7. Remove proxy + CA afterwards.

---

## 5. File map

| File | Role |
|---|---|
| `packages/mobile/plugins/withSslPinning.js` | Config plugin — writes Android network_security_config + iOS NSPinnedDomains at prebuild; env-gated |
| `packages/mobile/eas.json` | `SSL_PINNING=true` on preview + production env |
| `packages/mobile/src/lib/pinning.ts` | Offline-vs-intercepted heuristic + probe + zustand store |
| `packages/mobile/src/components/NetworkSecurityScreen.tsx` | Full-screen blocking UX |
| `packages/mobile/src/lib/api.ts` | Interceptor feeds success/network-failure signals to the heuristic |
| `packages/mobile/app/_layout.tsx` | Renders the blocking screen above the router stack |
| `packages/web/public/pinning-status.json` | Unpinned advisory channel (CloudFront) — incident messaging |
| `packages/mobile/src/__tests__/sslPinning.test.ts` | 15 guards: pin set, XML shape, plist shape, env gating, wiring, heuristic |
