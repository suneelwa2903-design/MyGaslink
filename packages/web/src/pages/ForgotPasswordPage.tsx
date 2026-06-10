import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { HiOutlineArrowRight, HiOutlineArrowLeft, HiOutlineCheckCircle } from 'react-icons/hi2';
import { z } from 'zod';
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from '@gaslink/shared';
import { apiPost, getErrorMessage } from '@/lib/api';

// Group B Part 7 — Bug 2 fix. Three-step forgot-password flow:
//   1. enter email/phone identifier → POST /api/auth/forgot-password sends OTP
//   2. enter OTP + new password + confirm → POST /api/auth/verify-reset-otp
//      gets a 5-min reset token, then POST /api/auth/reset-password commits
//   3. success view with "Sign in now" CTA
// The previous build had a /forgot-password Link on LoginPage but no route
// to land on — clicking it 404'd. This page closes that gap. Public route,
// no auth required.
type Step = 'email' | 'otp' | 'done';

const ic =
  'w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-flame-500 focus:ring-1 focus:ring-flame-500/20 transition-colors';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('email');
  const [identifier, setIdentifier] = useState('');

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <div className="flex items-center gap-3 mb-8">
          <img src="/logo.png" alt="MyGasLink" className="h-14 w-14 rounded-xl object-contain" />
          <span className="text-2xl font-extrabold text-[#1e3a5f] dark:text-white">
            MyGas<span className="text-flame-500">Link</span>
          </span>
        </div>

        {step === 'email' && (
          <EmailStep
            onSent={(id) => {
              setIdentifier(id);
              setStep('otp');
            }}
          />
        )}

        {step === 'otp' && (
          <OtpStep
            identifier={identifier}
            onBack={() => setStep('email')}
            onComplete={() => setStep('done')}
          />
        )}

        {step === 'done' && (
          <DoneStep onContinue={() => navigate('/login', { replace: true })} />
        )}

        <p className="mt-8 text-center text-sm text-slate-500">
          Remember your password?{' '}
          <Link to="/login" className="text-flame-500 hover:text-flame-400 font-medium">
            Sign in
          </Link>
        </p>
      </motion.div>
    </div>
  );
}

function EmailStep({ onSent }: { onSent: (identifier: string) => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { identifier: '' },
  });

  const mutation = useMutation({
    mutationFn: (data: ForgotPasswordInput) => apiPost('/auth/forgot-password', data),
    // The API never reveals whether the identifier exists — it returns 200
    // even on miss. We mirror that behaviour on the frontend: every submit
    // moves the user to the OTP step. If the email doesn't match a real
    // account, the OTP just never arrives.
    onSuccess: (_, vars) => {
      toast.success('If an account exists, an OTP has been emailed.');
      onSent(vars.identifier);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <>
      <h1 className="text-3xl font-extrabold text-slate-900 dark:text-white mb-2">Forgot your password?</h1>
      <p className="text-slate-500 mb-8">Enter the email or phone tied to your account and we&apos;ll send you a one-time code.</p>

      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">Email or phone</label>
          <input
            type="text"
            placeholder="you@example.com or 9876543210"
            autoComplete="email"
            className={ic}
            {...register('identifier')}
          />
          {errors.identifier && <p className="text-xs text-red-400 mt-1">{errors.identifier.message}</p>}
        </div>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full py-3.5 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {mutation.isPending ? 'Sending…' : <>Send reset code <HiOutlineArrowRight className="h-4 w-4" /></>}
        </button>
      </form>
    </>
  );
}

// Compound state for the OTP step: it has to call TWO endpoints (verify-otp
// then reset-password) on a single submit. The verify step returns a JWT
// reset token; the reset step consumes it. Wrapping both in one mutation
// makes the UX a single button click. The schema is rebuilt locally so the
// form surface stays flat (no resetToken field) — the same min(8)/match
// rules from `resetPasswordSchema` are applied without reaching into Zod
// internals.
const otpStepSchema = z
  .object({
    identifier: z.string().min(1, 'Email or phone is required'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
type OtpStepInput = z.infer<typeof otpStepSchema>;

function OtpStep({
  identifier,
  onBack,
  onComplete,
}: {
  identifier: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<OtpStepInput>({
    resolver: zodResolver(otpStepSchema),
    defaultValues: { identifier, otp: '', newPassword: '', confirmPassword: '' },
  });

  const mutation = useMutation({
    mutationFn: async (data: OtpStepInput) => {
      const verifyRes = await apiPost<{ resetToken: string }>('/auth/verify-reset-otp', {
        identifier: data.identifier,
        otp: data.otp,
      });
      await apiPost('/auth/reset-password', {
        resetToken: verifyRes.resetToken,
        newPassword: data.newPassword,
        confirmPassword: data.confirmPassword,
      });
    },
    onSuccess: () => {
      toast.success('Password reset — you can sign in now.');
      onComplete();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-4"
      >
        <HiOutlineArrowLeft className="h-3 w-3" />Use a different email
      </button>
      <h1 className="text-3xl font-extrabold text-slate-900 dark:text-white mb-2">Check your email</h1>
      <p className="text-slate-500 mb-8">
        We sent a 6-digit code to <span className="font-medium text-slate-700 dark:text-slate-300">{identifier}</span>.
        Enter it below along with your new password.
      </p>

      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-5">
        <input type="hidden" {...register('identifier')} />
        <div>
          <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">6-digit code</label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            autoComplete="one-time-code"
            className={`${ic} tracking-widest text-center font-mono text-lg`}
            {...register('otp')}
          />
          {errors.otp && <p className="text-xs text-red-400 mt-1">{errors.otp.message}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">New password</label>
          <input
            type="password"
            placeholder="At least 8 characters"
            autoComplete="new-password"
            className={ic}
            {...register('newPassword')}
          />
          {errors.newPassword && <p className="text-xs text-red-400 mt-1">{errors.newPassword.message}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5">Confirm new password</label>
          <input
            type="password"
            placeholder="Type it again"
            autoComplete="new-password"
            className={ic}
            {...register('confirmPassword')}
          />
          {errors.confirmPassword && <p className="text-xs text-red-400 mt-1">{errors.confirmPassword.message}</p>}
        </div>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full py-3.5 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {mutation.isPending ? 'Resetting…' : <>Reset password <HiOutlineArrowRight className="h-4 w-4" /></>}
        </button>
      </form>
    </>
  );
}

function DoneStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="text-center">
      <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 mb-6">
        <HiOutlineCheckCircle className="h-10 w-10" />
      </div>
      <h1 className="text-3xl font-extrabold text-slate-900 dark:text-white mb-2">Password reset complete</h1>
      <p className="text-slate-500 mb-8">You can now sign in with your new password.</p>
      <button
        type="button"
        onClick={onContinue}
        className="inline-flex items-center justify-center gap-2 py-3.5 px-8 bg-flame-500 hover:bg-flame-600 text-white font-semibold rounded-xl transition-colors"
      >
        Sign in <HiOutlineArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
