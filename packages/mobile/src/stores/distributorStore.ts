import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

interface DistributorState {
  selectedDistributorId: string | null;
  selectedDistributorName: string | null;
  setSelectedDistributor: (id: string | null, name: string | null) => void;
  clearSelectedDistributor: () => void;
}

export const useDistributorStore = create<DistributorState>()((set) => ({
  selectedDistributorId: null,
  selectedDistributorName: null,

  setSelectedDistributor: (id, name) => {
    if (id) {
      SecureStore.setItemAsync('selectedDistributorId', id).catch(() => {});
    } else {
      SecureStore.deleteItemAsync('selectedDistributorId').catch(() => {});
    }
    set({ selectedDistributorId: id, selectedDistributorName: name });
  },

  clearSelectedDistributor: () => {
    SecureStore.deleteItemAsync('selectedDistributorId').catch(() => {});
    set({ selectedDistributorId: null, selectedDistributorName: null });
  },
}));
