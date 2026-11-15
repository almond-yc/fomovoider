import { Wordmark } from '@/components/wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { useAuthActions } from '@convex-dev/auth/react';
import { Link } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const MIN_PASSWORD = 8;

// Email and password through Convex Auth's Password provider.
export function AuthForm({ flow }: { flow: 'signUp' | 'signIn' }) {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const signingUp = flow === 'signUp';

  async function submit() {
    const trimmed = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) return setError('Enter a valid email.');
    if (signingUp && password.length < MIN_PASSWORD) {
      return setError(`Use at least ${MIN_PASSWORD} characters for the password.`);
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await signIn('password', { email: trimmed, password, flow });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        signingUp
          ? message.includes('already exists')
            ? 'An account with this email already exists. Sign in instead.'
            : "Couldn't create the account. Try again."
          : 'Wrong email or password.'
      );
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerClassName="flex-grow justify-center gap-8 px-8 py-10" keyboardShouldPersistTaps="handled">
          <View className="items-center gap-2">
            <Wordmark className="text-4xl" />
            <Text variant="muted" className="text-center">
              {signingUp ? 'Create your account.' : 'Welcome back.'}
            </Text>
          </View>
          <View className="gap-4">
            <View className="gap-2">
              <Label nativeID="email">Email</Label>
              <Input
                aria-labelledby="email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType={signingUp ? 'username' : 'emailAddress'}
                returnKeyType="next"
              />
            </View>
            <View className="gap-2">
              <Label nativeID="password">Password</Label>
              <Input
                aria-labelledby="password"
                value={password}
                onChangeText={setPassword}
                placeholder={signingUp ? `At least ${MIN_PASSWORD} characters` : undefined}
                secureTextEntry
                autoComplete={signingUp ? 'new-password' : 'current-password'}
                textContentType={signingUp ? 'newPassword' : 'password'}
                returnKeyType="go"
                onSubmitEditing={submit}
              />
            </View>
            {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
            <Button onPress={submit} disabled={submitting} className="mt-2">
              {submitting ? <ActivityIndicator color="white" /> : <Text>{signingUp ? 'Sign up' : 'Sign in'}</Text>}
            </Button>
          </View>
          <View className="flex-row items-center justify-center gap-1">
            <Text variant="muted">{signingUp ? 'Have an account?' : 'New to Fomovoider?'}</Text>
            <Link href={signingUp ? '/sign-in' : '/sign-up'} replace asChild>
              <Button variant="link" size="sm" className="px-1">
                <Text>{signingUp ? 'Sign in' : 'Sign up'}</Text>
              </Button>
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
