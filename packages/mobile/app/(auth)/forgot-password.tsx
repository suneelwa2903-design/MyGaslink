import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { apiPost, getErrorMessage } from '../../src/lib/api';
import { useTheme, ACCENT } from '../../src/theme';

type Step = 'identifier' | 'otp' | 'new-password';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { dark, colors } = useTheme();
  const flame = ACCENT.red;

  const [step, setStep] = useState<Step>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [otp, setOtp] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // OTP countdown
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountdown = useCallback(() => {
    setCountdown(600); // 10 minutes in seconds
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Step 1: Request OTP
  const handleRequestOtp = async () => {
    if (!identifier.trim()) {
      Alert.alert('Error', 'Please enter your email or phone number');
      return;
    }
    setLoading(true);
    try {
      await apiPost('/auth/forgot-password', { identifier: identifier.trim() });
      startCountdown();
      setStep('otp');
      Alert.alert('OTP Sent', 'If an account exists, an OTP has been sent to the registered email.');
    } catch (error) {
      Alert.alert('Error', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify OTP
  const handleVerifyOtp = async () => {
    if (otp.length !== 6) {
      Alert.alert('Error', 'Please enter the 6-digit OTP');
      return;
    }
    setLoading(true);
    try {
      const result = await apiPost<{ resetToken: string }>('/auth/verify-reset-otp', {
        identifier: identifier.trim(),
        otp,
      });
      setResetToken(result.resetToken);
      setStep('new-password');
    } catch (error) {
      Alert.alert('Invalid OTP', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  // Step 3: Reset password
  const handleResetPassword = async () => {
    if (newPassword.length < 8) {
      Alert.alert('Error', 'Password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await apiPost('/auth/reset-password', {
        resetToken,
        newPassword,
        confirmPassword,
      });
      Alert.alert('Success', 'Password reset successfully. Please login with your new password.', [
        { text: 'Login', onPress: () => router.replace('/(auth)/login') },
      ]);
    } catch (error) {
      Alert.alert('Error', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP
  const handleResendOtp = async () => {
    setLoading(true);
    try {
      await apiPost('/auth/forgot-password', { identifier: identifier.trim() });
      startCountdown();
      setOtp('');
      Alert.alert('OTP Resent', 'A new OTP has been sent to your registered email.');
    } catch (error) {
      Alert.alert('Error', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.inputBorder,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    backgroundColor: colors.inputBg,
    color: colors.text,
  };

  const labelStyle = {
    fontSize: 13,
    fontWeight: '600' as const,
    color: colors.text,
    marginBottom: 6,
  };

  // Step indicators
  const steps: { key: Step; label: string }[] = [
    { key: 'identifier', label: 'Email/Phone' },
    { key: 'otp', label: 'Verify OTP' },
    { key: 'new-password', label: 'New Password' },
  ];
  const currentStepIndex = steps.findIndex((s) => s.key === step);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 24, paddingTop: 16 }}>
          {/* Header */}
          <TouchableOpacity
            onPress={() => {
              if (step === 'identifier') {
                router.back();
              } else if (step === 'otp') {
                setStep('identifier');
                setOtp('');
              } else {
                setStep('otp');
              }
            }}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
            <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text, marginLeft: 8 }}>
              {step === 'identifier' ? 'Back to Login' : 'Back'}
            </Text>
          </TouchableOpacity>

          {/* Title */}
          <Text style={{ fontSize: 24, fontWeight: '800', color: colors.text, marginBottom: 4 }}>
            Reset Password
          </Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 24 }}>
            {step === 'identifier' && 'Enter your registered email or phone number'}
            {step === 'otp' && 'Enter the 6-digit code sent to your email'}
            {step === 'new-password' && 'Choose a new password for your account'}
          </Text>

          {/* Step Indicator */}
          <View style={{ flexDirection: 'row', marginBottom: 32 }}>
            {steps.map((s, i) => (
              <View key={s.key} style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                <View style={{
                  width: 28, height: 28, borderRadius: 14,
                  backgroundColor: i <= currentStepIndex ? flame : dark ? '#334155' : '#e2e8f0',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {i < currentStepIndex ? (
                    <Ionicons name="checkmark" size={16} color="#fff" />
                  ) : (
                    <Text style={{
                      fontSize: 13, fontWeight: '700',
                      color: i <= currentStepIndex ? '#fff' : colors.textSecondary,
                    }}>
                      {i + 1}
                    </Text>
                  )}
                </View>
                {i < steps.length - 1 && (
                  <View style={{
                    flex: 1, height: 2, marginHorizontal: 8,
                    backgroundColor: i < currentStepIndex ? flame : dark ? '#334155' : '#e2e8f0',
                  }} />
                )}
              </View>
            ))}
          </View>

          {/* Card */}
          <View style={{
            backgroundColor: colors.cardBg, borderRadius: 20, padding: 24,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
            shadowOpacity: dark ? 0.3 : 0.08, shadowRadius: 16, elevation: 3,
            borderWidth: 1, borderColor: colors.cardBorder,
          }}>
            {/* Step 1: Identifier */}
            {step === 'identifier' && (
              <>
                <View style={{ marginBottom: 20 }}>
                  <Text style={labelStyle}>Email or Phone</Text>
                  <TextInput
                    value={identifier}
                    onChangeText={setIdentifier}
                    placeholder="you@company.com or 9876543210"
                    placeholderTextColor={colors.textSecondary}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={inputStyle}
                  />
                </View>
                <TouchableOpacity
                  onPress={handleRequestOtp}
                  disabled={loading}
                  style={{
                    backgroundColor: flame, borderRadius: 12, paddingVertical: 16,
                    alignItems: 'center', opacity: loading ? 0.7 : 1,
                  }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Send OTP</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            {/* Step 2: OTP */}
            {step === 'otp' && (
              <>
                <View style={{ marginBottom: 16 }}>
                  <Text style={labelStyle}>Enter OTP</Text>
                  <TextInput
                    value={otp}
                    onChangeText={(t) => setOtp(t.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    placeholderTextColor={colors.textSecondary}
                    keyboardType="number-pad"
                    maxLength={6}
                    style={{
                      ...inputStyle,
                      fontSize: 24,
                      fontWeight: '700',
                      letterSpacing: 8,
                      textAlign: 'center',
                    }}
                  />
                </View>

                {/* Countdown */}
                <View style={{ alignItems: 'center', marginBottom: 20 }}>
                  {countdown > 0 ? (
                    <Text style={{ fontSize: 13, color: colors.textSecondary }}>
                      OTP expires in{' '}
                      <Text style={{ color: flame, fontWeight: '700' }}>{formatTime(countdown)}</Text>
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 13, color: ACCENT.orange, fontWeight: '600' }}>
                      OTP has expired
                    </Text>
                  )}
                </View>

                <TouchableOpacity
                  onPress={handleVerifyOtp}
                  disabled={loading || otp.length !== 6}
                  style={{
                    backgroundColor: flame, borderRadius: 12, paddingVertical: 16,
                    alignItems: 'center', opacity: loading || otp.length !== 6 ? 0.7 : 1,
                    marginBottom: 12,
                  }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Verify OTP</Text>
                  )}
                </TouchableOpacity>

                {/* Resend */}
                <TouchableOpacity
                  onPress={handleResendOtp}
                  disabled={loading || countdown > 540}
                  style={{ alignItems: 'center', paddingVertical: 8 }}
                >
                  <Text style={{
                    fontSize: 14, fontWeight: '600',
                    color: loading || countdown > 540 ? colors.textMuted : flame,
                  }}>
                    Resend OTP
                  </Text>
                </TouchableOpacity>
              </>
            )}

            {/* Step 3: New Password */}
            {step === 'new-password' && (
              <>
                <View style={{ marginBottom: 16 }}>
                  <Text style={labelStyle}>New Password</Text>
                  <View style={{ position: 'relative' }}>
                    <TextInput
                      value={newPassword}
                      onChangeText={setNewPassword}
                      placeholder="Min. 8 characters"
                      placeholderTextColor={colors.textSecondary}
                      secureTextEntry={!showPassword}
                      style={{ ...inputStyle, paddingRight: 56 }}
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

                <View style={{ marginBottom: 20 }}>
                  <Text style={labelStyle}>Confirm Password</Text>
                  <TextInput
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="Re-enter password"
                    placeholderTextColor={colors.textSecondary}
                    secureTextEntry={!showPassword}
                    style={inputStyle}
                  />
                  {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                    <Text style={{ fontSize: 12, color: flame, marginTop: 4 }}>
                      Passwords do not match
                    </Text>
                  )}
                </View>

                {/* Password strength hint */}
                {newPassword.length > 0 && newPassword.length < 8 && (
                  <View style={{
                    backgroundColor: dark ? 'rgba(245, 158, 11, 0.1)' : '#fffbeb',
                    padding: 12, borderRadius: 8, marginBottom: 16,
                  }}>
                    <Text style={{ fontSize: 12, color: ACCENT.orange }}>
                      Password must be at least 8 characters
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  onPress={handleResetPassword}
                  disabled={loading || newPassword.length < 8 || newPassword !== confirmPassword}
                  style={{
                    backgroundColor: flame, borderRadius: 12, paddingVertical: 16,
                    alignItems: 'center',
                    opacity: loading || newPassword.length < 8 || newPassword !== confirmPassword ? 0.7 : 1,
                  }}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Reset Password</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
