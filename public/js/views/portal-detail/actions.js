import { api } from '../../api.js';
import {
  centsToInput,
  confirmDialog,
  fmtMoney,
  openModal,
  toast,
  toCents,
} from '../../ui.js';
import { settleModalBody, topUpModalBody, withdrawModalBody } from './modals.js';

export function bindPortalActions({ portal, id, refresh, refreshIncluding }) {
  function on(selector, handler) {
    document.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
  }

  on('[data-action="topup"]', () => {
    openModal({
      title: `Top up ${portal.name}`,
      subtitle: `Current wallet balance ${fmtMoney(portal.balance_cents)}`,
      body: topUpModalBody(portal),
      submitLabel: 'Record top-up',
      async onSubmit(form) {
        const values = new FormData(form);
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter a top-up amount');
        if (!values.get('deposit_account_id')) throw new Error('Choose the account the money came from');
        await api.post(`/portals/${id}/topups`, {
          amount_cents: amount,
          topup_date: values.get('topup_date'),
          method: values.get('method'),
          reference: values.get('reference'),
          deposit_account_id: Number(values.get('deposit_account_id')),
        });
        toast(`Top-up of ${fmtMoney(amount)} recorded`);
        refreshIncluding(values.get('topup_date'));
      },
    });
  });

  on('[data-action="withdraw"]', () => {
    openModal({
      title: `Withdraw from ${portal.name}`,
      subtitle: `${fmtMoney(portal.balance_cents)} available`,
      body: withdrawModalBody(portal),
      submitLabel: 'Record withdrawal',
      async onSubmit(form) {
        const values = new FormData(form);
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter a withdrawal amount');
        if (!values.get('payment_account_id')) throw new Error('Choose the account to refund into');
        await api.post(`/portals/${id}/refund`, {
          amount_cents: amount,
          refund_date: values.get('refund_date'),
          method: values.get('method'),
          reference: values.get('reference'),
          payment_account_id: Number(values.get('payment_account_id')),
        });
        toast(`Withdrawal of ${fmtMoney(amount)} recorded`);
        refreshIncluding(values.get('refund_date'));
      },
    });
  });

  on('[data-action="settle"]', () => {
    const modal = openModal({
      title: `Settle a bill from ${portal.name}`,
      subtitle: `${fmtMoney(portal.balance_cents)} available in the wallet`,
      body: settleModalBody(portal),
      submitLabel: 'Settle bill',
      async onSubmit(form) {
        const values = new FormData(form);
        const billId = Number(values.get('bill_id'));
        if (!billId) throw new Error('Choose a bill');
        const amount = toCents(values.get('amount'));
        if (amount <= 0) throw new Error('Enter an amount');
        await api.post('/portals/settle-bill', {
          bill_id: billId,
          portal_id: id,
          amount_cents: amount,
          settle_date: values.get('settle_date'),
        });
        toast(`Settled ${fmtMoney(amount)} from the wallet`);
        refreshIncluding(values.get('settle_date'));
      },
      onMount(overlay) {
        const select = overlay.querySelector('#st-bill');
        const amountInput = overlay.querySelector('#st-amount');
        function sync() {
          const bill = portal.open_bills.find((item) => item.id === Number(select.value));
          amountInput.value = centsToInput(Math.min(bill ? bill.balance_cents : 0, portal.balance_cents));
        }
        select.addEventListener('change', sync);
        if (select.value) sync();
      },
    });
    return modal;
  });

  document.querySelectorAll('[data-delete-topup]').forEach((button) => {
    button.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Delete this top-up?',
        message: 'The top-up will be reversed and removed. You can only delete a top-up that has not been used yet.',
        confirmLabel: 'Delete top-up',
      });
      if (!confirmed) return;
      try {
        await api.del(`/portals/topups/${button.dataset.deleteTopup}`);
        toast('Top-up deleted');
        refresh();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  on('[data-action="archive"]', async () => {
    const confirmed = await confirmDialog({
      title: `Archive ${portal.name}?`,
      message: 'The portal is hidden from the active list but its history and balances are kept.',
      confirmLabel: 'Archive portal',
      danger: false,
    });
    if (!confirmed) return;
    try {
      await api.put(`/portals/${id}`, { is_active: false });
      toast('Portal archived');
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  on('[data-action="restore"]', async () => {
    try {
      await api.put(`/portals/${id}`, { is_active: true });
      toast('Portal restored');
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  on('[data-action="delete"]', async () => {
    const confirmed = await confirmDialog({
      title: `Delete ${portal.name}?`,
      message: 'This permanently removes the portal. You can only delete a portal that has no top-ups, withdrawals or settled bills.',
      confirmLabel: 'Delete portal',
    });
    if (!confirmed) return;
    try {
      await api.del(`/portals/${id}`);
      toast('Portal deleted');
      location.hash = '#/portals';
    } catch (error) {
      toast(error.message, 'error');
    }
  });


}
