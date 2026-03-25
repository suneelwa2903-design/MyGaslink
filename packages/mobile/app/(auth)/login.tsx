import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView, Alert, Image, FlatList } from 'react-native';
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
          {/* Logo + Brand */}
          <View style={{ alignItems: 'center', marginBottom: 32 }}>
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

          {/* Login Card */}
          <View style={{
            backgroundColor: dark ? 'rgba(30, 41, 59, 0.7)' : 'rgba(255, 255, 255, 0.7)', borderRadius: 20, padding: 24,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: dark ? 0.3 : 0.08, shadowRadius: 16, elevation: 3,
            borderWidth: 1, borderColor: colors.cardBorder,
          }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 4 }}>
              Welcome back
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 24 }}>
              Sign in to your account
            </Text>

            {/* Email */}
            <View style={{ marginBottom: 16 }}>
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
                  paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
                  backgroundColor: colors.inputBg, color: colors.text,
                }}
              />
            </View>

            {/* Password */}
            <View style={{ marginBottom: 20 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 }}>Password</Text>
              <View style={{ position: 'relative' }}>
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
                    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
                    backgroundColor: colors.inputBg, paddingRight: 56, color: colors.text,
                  }}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  style={{ position: 'absolute', right: 16, top: 14 }}
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
              style={{ alignSelf: 'flex-end', marginBottom: 16, marginTop: -12 }}
            >
              <Text style={{ color: flame, fontSize: 13, fontWeight: '600' }}>
                Forgot Password?
              </Text>
            </TouchableOpacity>

            {/* Sign In Button */}
            <TouchableOpacity
              onPress={handleLogin}
              disabled={loading}
              style={{
                backgroundColor: flame, borderRadius: 12, paddingVertical: 16,
                alignItems: 'center', opacity: loading ? 0.7 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                {loading ? 'Signing in...' : 'Sign In'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Footer with theme toggle */}
          <View style={{ alignItems: 'center', marginTop: 32, gap: 12 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
              Powered by MyGasLink
            </Text>

            <TouchableOpacity
              onPress={toggleTheme}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 20,
                backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
              }}
            >
              <Ionicons
                name={dark ? 'moon' : 'sunny'}
                size={14}
                color={colors.textSecondary}
              />
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>
                {dark ? 'Dark' : 'Light'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Feature highlights slider */}
          <FlatList
            data={FEATURE_HIGHLIGHTS}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 20, paddingBottom: 16, gap: 10 }}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 20,
                }}
              >
                <Ionicons name={item.icon} size={14} color={flame} />
                <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary }}>
                  {item.label}
                </Text>
              </View>
            )}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
