import axios from 'axios';

// Mock secure store before importing api module
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { getErrorMessage } from '../lib/api';

describe('getErrorMessage', () => {
  it('extracts message from Axios error response', () => {
    const error = {
      isAxiosError: true,
      response: {
        data: { error: 'Invalid credentials', success: false, data: null },
      },
      message: 'Request failed with status 401',
    };

    // Mock axios.isAxiosError
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

    expect(getErrorMessage(error)).toBe('Invalid credentials');
  });

  it('falls back to axios message when no response data', () => {
    const error = {
      isAxiosError: true,
      response: undefined,
      message: 'Network Error',
    };

    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);

    expect(getErrorMessage(error)).toBe('Network Error');
  });

  it('handles standard Error objects', () => {
    expect(getErrorMessage(new Error('Something failed'))).toBe('Something failed');
  });

  it('handles unknown error types', () => {
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
    expect(getErrorMessage('random error')).toBe('Something went wrong');
    expect(getErrorMessage(42)).toBe('Something went wrong');
    expect(getErrorMessage(null)).toBe('Something went wrong');
  });
});
