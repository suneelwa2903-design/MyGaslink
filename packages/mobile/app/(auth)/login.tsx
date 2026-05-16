import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView, Alert, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiPost, tokenStorage, getErrorMessage } from '../../src/lib/api';
import { useAuthStore } from '../../src/stores/authStore';
import { useThemeStore } from '../../src/stores/themeStore';
import { useTheme, ACCENT } from '../../src/theme';
import StarryBackground from '../../src/components/StarryBackground';
import type { LoginResponse } from '@gaslink/shared';

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
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const { dark, colors } = useTheme();

  const toggleTheme = toggleMode;

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      const result = await apiPost<LoginResponse>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });

      await tokenStorage.setTokens(result.tokens.accessToken, result.tokens.refreshToken);
      setUser(result.user);

      if (result.user.requiresPasswordReset) {
        Alert.alert('Password Reset Required', 'Please change your password on the web app first.');
        return;
      }

      switch (result.user.role) {
        case 'customer': router.replace('/(customer)/dashboard'); break;
        case 'driver': router.replace('/(driver)/orders'); break;
        case 'super_admin': router.replace('/(super-admin)/dashboard'); break;
        case 'finance': router.replace('/(finance)/dashboard'); break;
        case 'inventory': router.replace('/(inventory)/summary'); break;
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
              source={require('../../assets/logo.png')}
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
