import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
} from 'react-icons/hi2';
import {
  type Driver,
  type Vehicle,
  DriverStatus,
  VehicleStatus,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';

const DRIVER_STATUS_VARIANTS: Record<string, 'success' | 'neutral'> = {
  [DriverStatus.ACTIVE]: 'success',
  [DriverStatus.INACTIVE]: 'neutral',
};

const VEHICLE_STATUS_VARIANTS: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
  [VehicleStatus.IDLE]: 'success',
  [VehicleStatus.DISPATCHED]: 'info',
  [VehicleStatus.RETURNED]: 'warning',
  [VehicleStatus.INACTIVE]: 'neutral',
};


export default function FleetPage() {
  // Driver Assignment moved to the Orders page — Fleet is now just the
  // drivers + vehicles registry. Supports a ?tab= query param so other
  // pages (and bookmarks) can deep-link directly to a tab.
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') === 'vehicles' ? 'vehicles' : 'drivers') as 'drivers' | 'vehicles';
  const [tab, setTab] = useState<'drivers' | 'vehicles'>(initialTab);

  const tabs = [
    { key: 'drivers' as const, label: 'Drivers' },
    { key: 'vehicles' as const, label: 'Vehicles' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Fleet Management</h1>
        <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage drivers and vehicles</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-surface-200 dark:border-surface-700">
        <div className="flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'pb-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'drivers' && <DriversTab />}
      {tab === 'vehicles' && <VehiclesTab />}
    </div>
  );
}

// ─── Drivers Tab ──────────────────────────────────────────────────────────────

function DriversTab() {
  const queryClient = useQueryClient();
  const [driverFormOpen, setDriverFormOpen] = useState(false);
  const [editDriver, setEditDriver] = useState<Driver | null>(null);

  const { data: driversData, isLoading: driversLoading } = useQuery({
    queryKey: ['drivers'],
    queryFn: () => apiGet<{ drivers: Driver[] }>('/drivers'),
  });

  const drivers = driversData?.drivers ?? [];

  const deleteDriverMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/drivers/${id}`),
    onSuccess: () => { toast.success('Driver deleted'); queryClient.invalidateQueries({ queryKey: ['drivers'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditDriver(null); setDriverFormOpen(true); }}>
          <HiOutlinePlus className="h-4 w-4" />Add Driver
        </Button>
      </div>

      {driversLoading ? (
        <div className="flex justify-center py-12"><Loader /></div>
      ) : drivers.length === 0 ? (
        <EmptyState title="No drivers" action={<Button size="sm" onClick={() => setDriverFormOpen(true)}>Add Driver</Button>} />
      ) : (
        <div className="card divide-y divide-surface-100 dark:divide-surface-700">
          {drivers.map((driver) => (
            <div key={driver.driverId} className="flex items-center justify-between p-4 hover:bg-surface-50 dark:hover:bg-surface-800/30 transition-colors">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-surface-900 dark:text-white">{driver.driverName}</p>
                <p className="text-xs text-surface-500">{driver.phone}</p>
                {driver.vehicleNumber && <p className="text-xs text-brand-500 mt-0.5">Vehicle: {driver.vehicleNumber}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={DRIVER_STATUS_VARIANTS[driver.status] || 'neutral'}>{driver.status}</Badge>
                {driver.availableToday && <Badge variant="success">Available</Badge>}
                <button onClick={() => { setEditDriver(driver); setDriverFormOpen(true); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500">
                  <HiOutlinePencilSquare className="h-4 w-4" />
                </button>
                <button onClick={() => { if (confirm('Delete this driver?')) deleteDriverMutation.mutate(driver.driverId); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {driverFormOpen && (
        <DriverFormModal open={driverFormOpen} onClose={() => { setDriverFormOpen(false); setEditDriver(null); }} driver={editDriver} />
      )}
    </div>
  );
}

// ─── Vehicles Tab ──────────────────────────────────────────────────────────────

function VehiclesTab() {
  const queryClient = useQueryClient();
  const [vehicleFormOpen, setVehicleFormOpen] = useState(false);
  const [editVehicle, setEditVehicle] = useState<Vehicle | null>(null);

  const { data: vehiclesData, isLoading: vehiclesLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => apiGet<{ vehicles: Vehicle[] }>('/vehicles'),
  });

  const vehicles = vehiclesData?.vehicles ?? [];

  const deleteVehicleMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/vehicles/${id}`),
    onSuccess: () => { toast.success('Vehicle deleted'); queryClient.invalidateQueries({ queryKey: ['vehicles'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditVehicle(null); setVehicleFormOpen(true); }}>
          <HiOutlinePlus className="h-4 w-4" />Add Vehicle
        </Button>
      </div>

      {vehiclesLoading ? (
        <div className="flex justify-center py-12"><Loader /></div>
      ) : vehicles.length === 0 ? (
        <EmptyState title="No vehicles" action={<Button size="sm" onClick={() => setVehicleFormOpen(true)}>Add Vehicle</Button>} />
      ) : (
        <div className="card divide-y divide-surface-100 dark:divide-surface-700">
          {vehicles.map((vehicle) => (
            <div key={vehicle.vehicleId} className="flex items-center justify-between p-4 hover:bg-surface-50 dark:hover:bg-surface-800/30 transition-colors">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-surface-900 dark:text-white">{vehicle.vehicleNumber}</p>
                <p className="text-xs text-surface-500">{vehicle.vehicleType || 'N/A'} {vehicle.capacity ? `| Capacity: ${vehicle.capacity}` : ''}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={VEHICLE_STATUS_VARIANTS[vehicle.status] || 'neutral'}>{vehicle.status}</Badge>
                <button onClick={() => { setEditVehicle(vehicle); setVehicleFormOpen(true); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-500">
                  <HiOutlinePencilSquare className="h-4 w-4" />
                </button>
                <button onClick={() => { if (confirm('Delete this vehicle?')) deleteVehicleMutation.mutate(vehicle.vehicleId); }} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {vehicleFormOpen && (
        <VehicleFormModal open={vehicleFormOpen} onClose={() => { setVehicleFormOpen(false); setEditVehicle(null); }} vehicle={editVehicle} />
      )}
    </div>
  );
}

// ─── Driver Form Modal ──────────────────────────────────────────────────────

function DriverFormModal({ open, onClose, driver }: { open: boolean; onClose: () => void; driver: Driver | null }) {
  const queryClient = useQueryClient();
  const isEdit = !!driver;

  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: driver
      ? { driverName: driver.driverName, phone: driver.phone, licenseNumber: driver.licenseNumber || '', employmentType: driver.employmentType || '', status: driver.status }
      : { driverName: '', phone: '', licenseNumber: '', employmentType: '', status: DriverStatus.ACTIVE },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      isEdit ? apiPut(`/drivers/${driver.driverId}`, data) : apiPost('/drivers', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Driver updated' : 'Driver created');
      queryClient.invalidateQueries({ queryKey: ['drivers'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const statusOptions = Object.values(DriverStatus).map((s) => ({ value: s, label: s }));

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Driver' : 'Add Driver'}>
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Input label="Driver Name" required {...register('driverName', { required: 'Required' })} error={errors.driverName?.message} />
        <Input label="Phone" required {...register('phone', { required: 'Required' })} error={errors.phone?.message} />
        <Input label="License Number" {...register('licenseNumber')} />
        <Input label="Employment Type" placeholder="e.g. Full-time, Contract" {...register('employmentType')} />
        <Select label="Status" options={statusOptions} {...register('status')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Vehicle Form Modal ──────────────────────────────────────────────────────

function VehicleFormModal({ open, onClose, vehicle }: { open: boolean; onClose: () => void; vehicle: Vehicle | null }) {
  const queryClient = useQueryClient();
  const isEdit = !!vehicle;

  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: vehicle
      ? { vehicleNumber: vehicle.vehicleNumber, vehicleType: vehicle.vehicleType || '', capacity: vehicle.capacity || 0, status: vehicle.status }
      : { vehicleNumber: '', vehicleType: '', capacity: 0, status: VehicleStatus.IDLE },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      isEdit ? apiPut(`/vehicles/${vehicle.vehicleId}`, data) : apiPost('/vehicles', data),
    onSuccess: () => {
      toast.success(isEdit ? 'Vehicle updated' : 'Vehicle created');
      queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const statusOptions = Object.values(VehicleStatus).map((s) => ({ value: s, label: s }));

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Vehicle' : 'Add Vehicle'}>
      <form onSubmit={handleSubmit((data) => mutation.mutate({ ...data, capacity: Number(data.capacity) || null }))} className="space-y-4">
        <Input label="Vehicle Number" required {...register('vehicleNumber', { required: 'Required' })} error={errors.vehicleNumber?.message} />
        <Input label="Vehicle Type" placeholder="e.g. Truck, Tempo" {...register('vehicleType')} />
        <Input label="Capacity" type="number" {...register('capacity', { valueAsNumber: true })} />
        <Select label="Status" options={statusOptions} {...register('status')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>{isEdit ? 'Update' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
