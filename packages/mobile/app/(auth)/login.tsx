import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView, Alert, Image, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { apiPost, tokenStorage, getErrorMessage } from '../../src/lib/api';
import { useAuthStore } from '../../src/stores/authStore';
import { useThemeStore } from '../../src/stores/themeStore';
import { useTheme, ACCENT } from '../../src/theme';
import StarryBackground from '../../src/components/StarryBackground';
import type { LoginResponse } from '@gaslink/shared';
import logo from '../../assets/logo.png';

/**
 * M13 — DPDP consent gate.
 *
 * India's Digital Personal Data Protection Act 2023 requires explicit
 * consent before collecting/processing personal data. The checkbox below
 * the password field forces affirmative action on first login on this
 * device; once consented we persist `dpdp_consent_v1=true` to SecureStore
 * so the box is pre-checked on subsequent logins. The key is versioned so
 * a policy change can force re-consent without colliding with the old
 * value.
 *
 * Existing logged-in users never see this screen because authStore.hydrate
 * routes them straight to their role's home, so we don't block them.
 */
const DPDP_CONSENT_KEY = 'dpdp_consent_v1';
const PRIVACY_POLICY_URL = Platform.OS === 'ios'
  ? 'https://mygaslink.com/legal/privacy'
  : 'https://mygaslink.com/privacy';

const FEATURE_HIGHLIGHTS = [
  { key: 'tracking', icon: 'location-outline' as const, label: 'Real-time Tracking' },
  { key: 'analytics', icon: 'bar-chart-outline' as const, label: 'Smart Analytics' },
  { key: 'fleet', icon: 'car-outline' as const, label: 'Fleet Management' },
  { key: 'invoices', icon: 'receipt-outline' as const, label: 'Digital Invoices' },
  { key: 'gst', icon: 'shield-checkmark-outline' as const, label: 'GST Compliant' },
];

export default function LoginScreen() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [dpdpConsent, setDpdpConsent] = useState(false);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const { dark, colors } = useTheme();

  const toggleTheme = toggleMode;

  // Pre-fill consent from SecureStore so a returning user who has already
  // consented doesn't have to tick the box every time they re-authenticate.
  useEffect(() => {
    SecureStore.getItemAsync(DPDP_CONSENT_KEY)
      .then((v) => {
        if (v === 'true') setDpdpConsent(true);
      })
      .catch(() => {
        // SecureStore read failure is non-fatal — user just has to consent again.
      });
  }, []);

  const handleOpenPrivacyPolicy = () => {
    Linking.openURL(PRIVACY_POLICY_URL).catch(() =>
      Alert.alert('Could not open browser', PRIVACY_POLICY_URL),
    );
  };

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }
    if (!dpdpConsent) {
      Alert.alert(
        'Consent required',
        'Please review and accept the Privacy Policy before signing in.',
      );
      return;
    }

    setLoading(true);
    try {
      // Item 4 (2026-07-09) — include a device label so the newly-created
      // refresh_token_sessions row is identifiable. `Platform.constants`
      // exposes the model on Android; iOS Platform.constants is thinner
      // so we fall back to a static "iOS device" label. Doesn't need to
      // be unique — this is a human-readable tag for future "logged in
      // devices" UI, not an identity primitive.
      const deviceLabel = Platform.OS === 'ios'
        ? 'iOS device'
        : `Android - ${(Platform.constants as { Model?: string })?.Model ?? 'device'}`;
      const result = await apiPost<LoginResponse>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
        deviceLabel,
      });

      await tokenStorage.setTokens(result.tokens.accessToken, result.tokens.refreshToken);
      // Persist the consent only after a successful login so a typo on the
      // password field doesn't lock in a tick the user might want to revoke.
      try {
        await SecureStore.setItemAsync(DPDP_CONSENT_KEY, 'true');
      } catch {
        // Non-fatal — they'll just have to consent again next login.
      }
      setUser(result.user);

      if (result.user.requiresPasswordReset) {
        // Phase 6i (2026-06-12): in-app force-password-reset flow. Pre-
        // Phase-6i this bounced the user to the web app — broken in the
        // field for drivers who only have the mobile app installed.
        router.replace('/(auth)/force-password-reset');
        return;
      }

      switch (result.user.role) {
        case 'customer': router.replace('/(customer)/dashboard'); break;
        case 'driver': router.replace('/(driver)/orders'); break;
        case 'super_admin': router.replace('/(super-admin)/dashboard'); break;
        case 'finance': router.replace('/(finance)/dashboard'); break;
        case 'inventory': router.replace('/(inventory)/analytics'); break;
        default: router.replace('/(admin)/dashboard'); break; // distributor_admin
      }
    } catch (error) {
      Alert.alert('Login Failed', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const flame = ACCENT.red;
  const brandText = dark ? '#ffffff' : ACCENT.navy;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StarryBackground dark={dark} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 }}>
          {/* Logo + Brand — marginTop: 60 keeps the logo off the status bar
              even on phones with short notches. 16px gap between logo image
              and the wordmark, then a slim subtitle. */}
          <View style={{ alignItems: 'center', marginTop: 60, marginBottom: 32 }}>
            <Image
              source={logo}
              style={{
                width: 88, height: 88, borderRadius: 20, marginBottom: 16,
              }}
              resizeMode="contain"
            />
            <Text style={{ fontSize: 28, fontWeight: '800' }}>
              <Text style={{ color: brandText }}>MyGas</Text>
              <Text style={{ color: flame }}>Link</Text>
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 4 }}>
              Commercial LPG Distribution Platform
            </Text>
          </View>

          {/* Login Card — modernised: bigger radius, softer shadow, 8px
              vertical rhythm between form elements (via parent gap). */}
          <View style={{
            backgroundColor: dark ? 'rgba(30, 41, 59, 0.7)' : 'rgba(255, 255, 255, 0.7)',
            borderRadius: 24,
            paddingHorizontal: 24,
            paddingVertical: 32,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.08,
            shadowRadius: 16,
            elevation: 8,
            borderWidth: 1,
            borderColor: colors.cardBorder,
            gap: 8,
          }}>
            {/* Email */}
            <View>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@company.com"
                placeholderTextColor={colors.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                selectionColor={ACCENT.red}
                style={{
                  borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12,
                  height: 52, paddingHorizontal: 16, fontSize: 16,
                  backgroundColor: dark ? colors.inputBg : '#f8fafc', color: colors.text,
                }}
              />
            </View>

            {/* Password */}
            <View>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Password</Text>
              <View style={{ position: 'relative', justifyContent: 'center' }}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showPassword}
                  autoComplete="off"
                  selectionColor={ACCENT.red}
                  style={{
                    borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12,
                    height: 52, paddingHorizontal: 16, fontSize: 16,
                    backgroundColor: dark ? colors.inputBg : '#f8fafc',
                    paddingRight: 56, color: colors.text,
                  }}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  style={{ position: 'absolute', right: 16 }}
                >
                  <Text style={{ color: flame, fontSize: 13, fontWeight: '600' }}>
                    {showPassword ? 'Hide' : 'Show'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Forgot Password */}
            <TouchableOpacity
              onPress={() => router.push('/(auth)/forgot-password')}
              style={{ alignSelf: 'flex-end' }}
            >
              <Text style={{ color: flame, fontSize: 13, fontWeight: '600' }}>
                Forgot Password?
              </Text>
            </TouchableOpacity>

            {/* M13 — DPDP consent (India DPDP Act 2023). Required before
                login; persisted in SecureStore as `dpdp_consent_v1` so a
                returning user only ticks it once per install. The
                Privacy Policy text inside the label is its own tap target
                and opens the platform-specific legal page without toggling
                the checkbox. */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                paddingVertical: 4,
              }}
            >
              <TouchableOpacity
                onPress={() => setDpdpConsent((v) => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: dpdpConsent }}
                accessibilityLabel="I agree to the Privacy Policy and consent to processing of my personal data"
                style={{
                  width: 20,
                  height: 20,
                  marginTop: 1,
                  borderRadius: 4,
                  borderWidth: 1.5,
                  borderColor: dpdpConsent ? flame : colors.inputBorder,
                  backgroundColor: dpdpConsent ? flame : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {dpdpConsent ? (
                  <Ionicons name="checkmark" size={14} color="#ffffff" />
                ) : null}
              </TouchableOpacity>
              <Text
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: colors.textSecondary,
                  lineHeight: 17,
                }}
                onPress={() => setDpdpConsent((v) => !v)}
              >
                {'I agree to the '}
                <Text
                  style={{ color: flame, fontWeight: '600', textDecorationLine: 'underline' }}
                  onPress={handleOpenPrivacyPolicy}
                >
                  Privacy Policy
                </Text>
                {' and consent to processing of my personal data.'}
              </Text>
            </View>

            {/* Sign In Button — solid flame red (#e11d1d via ACCENT.red),
                52px tall, 14px radius. No gradient library; the solid brand
                colour reads "primary action" on its own. */}
            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              style={{
                backgroundColor: flame,
                borderRadius: 14,
                height: 52,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: loading ? 0.7 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                {loading ? 'Signing in...' : 'Sign In'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Footer: small "Powered by" caption + theme toggle pill,
              sitting just above the feature strip. The toggle pill uses
              the same surface/border tokens as the rest of the chrome so
              it doesn't read as a separate UI region. */}
          <View style={{ alignItems: 'center', marginTop: 28, gap: 10 }}>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>
              Powered by MyGasLink
            </Text>

            <TouchableOpacity
              onPress={toggleTheme}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 16,
                paddingVertical: 6,
                borderRadius: 20,
                backgroundColor: colors.cardBg,
                borderWidth: 1,
                borderColor: colors.cardBorder,
              }}
            >
              {/* Show the action — i.e. what tapping will switch TO —
                  not the current state. Sun icon = "tap to go light",
                  moon icon = "tap to go dark". */}
              <Ionicons
                name={dark ? 'sunny' : 'moon'}
                size={14}
                color={colors.textSecondary}
              />
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                {dark ? 'Light' : 'Dark'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Feature highlights — vertical stack of full-width rows. Icon
              on the left, label on the right; 8px gap between rows. The
              horizontal carousel didn't justify its own scroll affordance
              for only 5 items, so we lay them out vertically and let the
              outer ScrollView handle the page scroll. */}
          <View style={{ gap: 8, paddingTop: 16, paddingBottom: 16 }}>
            {FEATURE_HIGHLIGHTS.map((item) => (
              <View
                key={item.key}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  borderRadius: 16,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  backgroundColor: colors.cardBg,
                  borderWidth: 1,
                  borderColor: colors.cardBorder,
                }}
              >
                <Ionicons name={item.icon} size={22} color={flame} />
                <Text style={{
                  fontSize: 14,
                  fontWeight: '500',
                  color: colors.text,
                }}>
                  {item.label}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
