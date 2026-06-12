import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineLink,
  HiOutlineEye,
} from 'react-icons/hi2';
import {
  type Driver,
  type Vehicle,
  type DriverVehicleAssignment,
  DriverStatus,
  VehicleStatus,
  ASSIGNMENT_STATUS_VARIANTS,
  assignmentStatusLabel,
  localTodayISO,
} from '@gaslink/shared';
import { apiGet, apiPost, apiPut, apiDelete, getErrorMessage } from '@/lib/api';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

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

export default function DriversVehiclesPage() {
  const queryClient = useQueryClient();
  const [driverFormOpen, setDriverFormOpen] = useState(false);
  const [vehicleFormOpen, setVehicleFormOpen] = useState(false);
  const [editDriver, setEditDriver] = useState<Driver | null>(null);
  const [editVehicle, setEditVehicle] = useState<Vehicle | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [viewAssignments, setViewAssignments] = useState(false);

  const { data: driversData, isLoading: driversLoading } = useQuery({
    queryKey: ['drivers'],
    queryFn: () => apiGet<{ drivers: Driver[] }>('/drivers'),
  });

  const { data: vehiclesData, isLoading: vehiclesLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => apiGet<{ vehicles: Vehicle[] }>('/vehicles'),
  });

  const { data: assignments, isLoading: assignmentsLoading } = useQuery({
    queryKey: ['assignments'],
    queryFn: () => apiGet<DriverVehicleAssignment[]>('/assignments', { status: 'active' }),
    enabled: viewAssignments,
  });

  const drivers = driversData?.drivers ?? [];
  const vehicles = vehiclesData?.vehicles ?? [];

  const deleteDriverMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/drivers/${id}`),
    onSuccess: () => { toast.success('Driver deleted'); queryClient.invalidateQueries({ queryKey: ['drivers'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const deleteVehicleMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/vehicles/${id}`),
    onSuccess: () => { toast.success('Vehicle deleted'); queryClient.invalidateQueries({ queryKey: ['vehicles'] }); },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">Drivers & Vehicles</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">Manage fleet and driver assignments</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setViewAssignments(true)}>
            <HiOutlineEye className="h-4 w-4" />Assignments
          </Button>
          <Button variant="secondary" onClick={() => setAssignmentOpen(true)}>
            <HiOutlineLink className="h-4 w-4" />Create Assignment
          </Button>
        </div>
      </div>

      {/* Two Panel Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Drivers Panel */}
        <div className="card">
          <div className="flex items-center justify-between p-4 border-b border-surface-200 dark:border-surface-700">
            <h2 className="font-semibold text-surface-900 dark:text-white">Drivers</h2>
            <Button size="sm" onClick={() => { setEditDriver(null); setDriverFormOpen(true); }}>
              <HiOutlinePlus className="h-3 w-3" />Add Driver
            </Button>
          </div>

          {driversLoading ? (
            <div className="flex justify-center py-12"><Loader /></div>
          ) : drivers.length === 0 ? (
            <EmptyState title="No drivers" action={<Button size="sm" onClick={() => setDriverFormOpen(true)}>Add Driver</Button>} />
          ) : (
            <div className="divide-y divide-surface-100 dark:divide-surface-700">
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
        </div>

        {/* Vehicles Panel */}
        <div className="card">
          <div className="flex items-center justify-between p-4 border-b border-surface-200 dark:border-surface-700">
            <h2 className="font-semibold text-surface-900 dark:text-white">Vehicles</h2>
            <Button size="sm" onClick={() => { setEditVehicle(null); setVehicleFormOpen(true); }}>
              <HiOutlinePlus className="h-3 w-3" />Add Vehicle
            </Button>
          </div>

          {vehiclesLoading ? (
            <div className="flex justify-center py-12"><Loader /></div>
          ) : vehicles.length === 0 ? (
            <EmptyState title="No vehicles" action={<Button size="sm" onClick={() => setVehicleFormOpen(true)}>Add Vehicle</Button>} />
          ) : (
            <div className="divide-y divide-surface-100 dark:divide-surface-700">
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
        </div>
      </div>

      {/* Driver Form Modal */}
      {driverFormOpen && (
        <DriverFormModal open={driverFormOpen} onClose={() => { setDriverFormOpen(false); setEditDriver(null); }} driver={editDriver} />
      )}

      {/* Vehicle Form Modal */}
      {vehicleFormOpen && (
        <VehicleFormModal open={vehicleFormOpen} onClose={() => { setVehicleFormOpen(false); setEditVehicle(null); }} vehicle={editVehicle} />
      )}

      {/* Create Assignment Modal */}
      {assignmentOpen && (
        <AssignmentModal open={assignmentOpen} onClose={() => setAssignmentOpen(false)} drivers={drivers} vehicles={vehicles} />
      )}

      {/* View Assignments Modal */}
      {viewAssignments && (
        <Modal open={viewAssignments} onClose={() => setViewAssignments(false)} title="Active Assignments" size="xl">
          {assignmentsLoading ? (
            <div className="flex justify-center py-8"><Loader /></div>
          ) : !assignments?.length ? (
            <EmptyState title="No active assignments" />
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr><th>Driver</th><th>Vehicle</th><th>Date</th><th>Trip #</th><th>Orders</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.assignmentId}>
                      <td className="font-medium">{a.driverName}</td>
                      <td>{a.vehicleNumber}</td>
                      <td>{new Date(a.assignmentDate).toLocaleDateString('en-IN')}</td>
                      <td>{a.tripNumber}</td>
                      <td>{a.orders.length}</td>
                      <td><Badge variant={ASSIGNMENT_STATUS_VARIANTS[a.status as keyof typeof ASSIGNMENT_STATUS_VARIANTS] || 'neutral'}>{assignmentStatusLabel(a.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
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

// ─── Assignment Modal ───────────────────────────────────────────────────────

function AssignmentModal({ open, onClose, drivers, vehicles }: { open: boolean; onClose: () => void; drivers: Driver[]; vehicles: Vehicle[] }) {
  const queryClient = useQueryClient();

  const { register, handleSubmit } = useForm({
    // Phase D (2026-06-12): local TZ.
    defaultValues: { driverId: '', vehicleId: '', assignmentDate: localTodayISO() },
  });

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => apiPost('/assignments', data),
    onSuccess: () => {
      toast.success('Assignment created');
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      queryClient.invalidateQueries({ queryKey: ['drivers'] });
      queryClient.invalidateQueries({ queryKey: ['vehicles'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const driverOptions = drivers.filter((d) => d.status === DriverStatus.ACTIVE).map((d) => ({ value: d.driverId, label: d.driverName }));
  const vehicleOptions = vehicles.filter((v) => v.status === VehicleStatus.IDLE).map((v) => ({ value: v.vehicleId, label: v.vehicleNumber }));

  return (
    <Modal open={open} onClose={onClose} title="Create Assignment">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <Select label="Driver" options={driverOptions} placeholder="Select driver" {...register('driverId')} />
        <Select label="Vehicle" options={vehicleOptions} placeholder="Select vehicle" {...register('vehicleId')} />
        <Input label="Assignment Date" type="date" {...register('assignmentDate')} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mutation.isPending}>Create Assignment</Button>
        </div>
      </form>
    </Modal>
  );
}
