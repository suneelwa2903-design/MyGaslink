import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlineEye,
  HiOutlineTrash,
} from 'react-icons/hi2';
import {
  type Order,
  type CylinderType,
  type PaginationMeta,
  createOrderSchema,
  type CreateOrderInput,
  orderStatusLabel,
  orderStatusVariant,
  localTodayISO,
} from '@gaslink/shared';
import { apiGet, apiPost, getErrorMessage } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { Button, Input, Select, Modal, Badge, Loader, EmptyState } from '@/components/ui';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
}

function formatOrderItemsOrdered(items: Order['items']): string {
  if (!items || items.length === 0) return '—';
  return items.map((it) => `${it.quantity}× ${it.cylinderTypeName ?? 'Unknown'}`).join(', ');
}

function formatOrderItemsDelivered(items: Order['items']): string {
  if (!items || items.length === 0) return '—';
  return items
    .map((it) => `${it.deliveredQuantity != null ? it.deliveredQuantity : it.quantity}× ${it.cylinderTypeName ?? 'Unknown'}`)
    .join(', ');
}

export default function CustomerOrdersPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [viewOrder, setViewOrder] = useState<Order | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['customer-orders', page],
    queryFn: () => apiGet<{ orders: Order[]; meta: PaginationMeta }>('/customer-portal/orders', { page, pageSize: 25 }),
  });

  const { data: cylinderTypes } = useQuery({
    queryKey: ['cylinder-types'],
    queryFn: () => apiGet<{ cylinderTypes: CylinderType[] }>('/cylinder-types'),
    select: (data) => data.cylinderTypes,
    staleTime: 10 * 60 * 1000,
  });

  const orders = data?.orders ?? [];
  const meta = data?.meta;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-surface-900 dark:text-white">{t('customerPortal.orders.title')}</h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">{t('customerPortal.orders.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <HiOutlinePlus className="h-4 w-4" />{t('customerPortal.orders.newOrder')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Loader size="lg" /></div>
      ) : orders.length === 0 ? (
        <EmptyState
          title={t('customerPortal.orders.noOrdersYet')}
          description={t('customerPortal.orders.noOrdersDesc')}
          action={<Button onClick={() => setCreateOpen(true)}><HiOutlinePlus className="h-4 w-4" />{t('customerPortal.orders.newOrder')}</Button>}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('customerPortal.orders.tableHeaders.orderNumber')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.orderDate')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.deliveryDate')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.items')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.amount')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.status')}</th>
                  <th>{t('customerPortal.orders.tableHeaders.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.orderId}>
                    <td className="font-medium text-surface-900 dark:text-white">{order.orderNumber}</td>
                    <td>{new Date(order.orderDate).toLocaleDateString('en-IN')}</td>
                    <td>{new Date(order.deliveryDate).toLocaleDateString('en-IN')}</td>
                    <td>
                      {order.status === 'modified_delivered' ? (
                        <div className="flex flex-col">
                          <span>{formatOrderItemsDelivered(order.items)}</span>
                          <span className="text-xs text-surface-500 dark:text-surface-400">
                            Ordered: {formatOrderItemsOrdered(order.items)}
                          </span>
                        </div>
                      ) : (
                        <span>{formatOrderItemsOrdered(order.items)}</span>
                      )}
                    </td>
                    <td className="font-medium">{formatCurrency(order.totalAmount)}</td>
                    <td><Badge variant={orderStatusVariant(order.status)}>{orderStatusLabel(order.status)}</Badge></td>
                    <td>
                      <button onClick={() => setViewOrder(order)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-700 text-brand-500">
                        <HiOutlineEye className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-500 dark:text-surface-400">{t('customerPortal.orders.pageOf', { page: meta.page, total: meta.totalPages })}</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('customerPortal.orders.previous')}</Button>
                <Button variant="secondary" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>{t('customerPortal.orders.next')}</Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* View Order Detail */}
      {viewOrder && (
        <Modal open={!!viewOrder} onClose={() => setViewOrder(null)} title={t('customerPortal.orders.viewModal.title', { orderNumber: viewOrder.orderNumber })} size="lg">
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div><p className="text-xs text-surface-400">{t('customerPortal.orders.viewModal.orderDate')}</p><p className="text-sm font-medium">{new Date(viewOrder.orderDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.orders.viewModal.deliveryDate')}</p><p className="text-sm font-medium">{new Date(viewOrder.deliveryDate).toLocaleDateString('en-IN')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.orders.viewModal.driver')}</p><p className="text-sm font-medium">{viewOrder.driverName || t('customerPortal.orders.viewModal.notAssigned')}</p></div>
              <div><p className="text-xs text-surface-400">{t('customerPortal.orders.viewModal.status')}</p><Badge variant={orderStatusVariant(viewOrder.status)}>{orderStatusLabel(viewOrder.status)}</Badge></div>
              {viewOrder.driverPhone && (
                <div className="col-span-2 sm:col-span-4 p-3 rounded-xl bg-brand-50 dark:bg-brand-500/10">
                  <p className="text-xs font-medium text-brand-700 dark:text-brand-300 mb-1">{t('customerPortal.orders.viewModal.yourDriver', 'Your delivery driver')}</p>
                  <p className="text-sm font-semibold text-surface-900 dark:text-white">{viewOrder.driverName}</p>
                  <a href={`tel:${viewOrder.driverPhone}`} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline">
                    📞 {viewOrder.driverPhone}
                  </a>
                </div>
              )}
            </div>
            <div className="table-container">
              <table className="table">
                <thead><tr>
                  <th>{t('customerPortal.orders.viewModal.cylinder')}</th>
                  <th>{t('customerPortal.orders.viewModal.qty')}</th>
                  <th>{t('customerPortal.orders.viewModal.delivered')}</th>
                  <th>{t('customerPortal.orders.viewModal.empties')}</th>
                  <th>{t('customerPortal.orders.viewModal.unitPrice')}</th>
                  <th>{t('customerPortal.orders.viewModal.total')}</th>
                </tr></thead>
                <tbody>
                  {viewOrder.items.map((item) => (
                    <tr key={item.orderItemId}>
                      <td className="font-medium">{item.cylinderTypeName}</td>
                      <td>{item.quantity}</td>
                      <td>{item.deliveredQuantity ?? '-'}</td>
                      <td>{item.emptiesCollected ?? '-'}</td>
                      <td>{formatCurrency(item.unitPrice)}</td>
                      <td className="font-medium">{formatCurrency(item.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-right"><p className="text-lg font-bold text-surface-900 dark:text-white">{t('customerPortal.orders.viewModal.totalLabel', { amount: formatCurrency(viewOrder.totalAmount) })}</p></div>
            {viewOrder.specialInstructions && (
              <div className="p-3 bg-surface-50 dark:bg-surface-800/50 rounded-xl">
                <p className="text-xs text-surface-400">{t('customerPortal.orders.viewModal.specialInstructions')}</p>
                <p className="text-sm text-surface-700 dark:text-surface-300">{viewOrder.specialInstructions}</p>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Create Order Modal */}
      {createOpen && (
        <CustomerCreateOrderModal open={createOpen} onClose={() => setCreateOpen(false)} cylinderTypes={cylinderTypes ?? []} customerId={user?.customerId || ''} />
      )}
    </div>
  );
}

function CustomerCreateOrderModal({ open, onClose, cylinderTypes, customerId }: { open: boolean; onClose: () => void; cylinderTypes: CylinderType[]; customerId: string }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      customerId,
      // Phase D (2026-06-12): local TZ — customerPortalService.ts
      // validates deliveryDate against local-TZ midnight.
      deliveryDate: localTodayISO(),
      specialInstructions: '',
      items: [{ cylinderTypeId: '', quantity: 1 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'items' });

  const mutation = useMutation({
    mutationFn: (data: CreateOrderInput) => apiPost('/customer-portal/orders', data),
    onSuccess: () => {
      toast.success(t('customerPortal.orders.createModal.orderPlacedSuccess'));
      queryClient.invalidateQueries({ queryKey: ['customer-orders'] });
      onClose();
    },
    onError: (error) => toast.error(getErrorMessage(error)),
  });

  const cylinderOptions = cylinderTypes.map((ct) => ({ value: ct.cylinderTypeId, label: `${ct.typeName} (${ct.capacity}${ct.unit})` }));

  return (
    <Modal open={open} onClose={onClose} title={t('customerPortal.orders.createModal.title')} size="lg">
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
        <input type="hidden" {...register('customerId')} />
        <Input label={t('customerPortal.orders.createModal.preferredDeliveryDate')} type="date" error={errors.deliveryDate?.message} {...register('deliveryDate')} />

        <div>
          <label className="label">{t('customerPortal.orders.createModal.orderItems')}</label>
          {fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2 mb-2">
              <div className="flex-1">
                <Select options={cylinderOptions} placeholder={t('customerPortal.orders.createModal.selectCylinder')} error={errors.items?.[index]?.cylinderTypeId?.message} {...register(`items.${index}.cylinderTypeId`)} />
              </div>
              <div className="w-24">
                <Input type="number" placeholder={t('customerPortal.orders.createModal.qtyPlaceholder')} min={1} error={errors.items?.[index]?.quantity?.message} {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
              </div>
              {fields.length > 1 && (
                <button type="button" onClick={() => remove(index)} className="mt-1 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-lg">
                  <HiOutlineTrash className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {errors.items?.message && <p className="error-text">{errors.items.message}</p>}
          <Button type="button" variant="ghost" size="sm" className="mt-1" onClick={() => append({ cylinderTypeId: '', quantity: 1 })}>
            <HiOutlinePlus className="h-3 w-3" />{t('customerPortal.orders.createModal.addItem')}
          </Button>
        </div>

        <Input label={t('customerPortal.orders.createModal.specialInstructionsLabel')} placeholder={t('customerPortal.orders.createModal.deliveryNotesPlaceholder')} {...register('specialInstructions')} />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={mutation.isPending}>{t('customerPortal.orders.createModal.placeOrder')}</Button>
        </div>
      </form>
    </Modal>
  );
}
