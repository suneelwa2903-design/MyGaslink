import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={{
          flex: 1, backgroundColor: '#f8fafc',
          alignItems: 'center', justifyContent: 'center', padding: 24,
        }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ fontSize: 20, fontWeight: '800', color: '#0f172a', textAlign: 'center' }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 8, maxWidth: 300 }}>
            An unexpected error occurred. Please try again.
          </Text>
          {this.state.error && (
            <View style={{
              marginTop: 16, backgroundColor: '#fef2f2', borderRadius: 12, padding: 12,
              maxWidth: '100%',
            }}>
              <Text style={{ fontSize: 12, color: '#991b1b', fontFamily: 'monospace' }} numberOfLines={3}>
                {this.state.error.message}
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={this.handleRetry}
            style={{
              marginTop: 24, backgroundColor: '#338dff', paddingHorizontal: 24,
              paddingVertical: 12, borderRadius: 12,
            }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}
