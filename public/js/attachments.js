import { api } from './api.js';
import { confirmDialog, esc, fmtDate, icon, toast } from './ui.js';

const MAX_BYTES = 15 * 1024 * 1024;

export async function loadAttachments(entityType, entityId) {
  try {
    return await api.get('/attachments', { entity_type: entityType, entity_id: entityId });
  } catch {
    return [];
  }
}

export function attachmentSection({ entityType, entityId, attachments, hint = 'Tickets, receipts and supporting documents' }) {
  return `
    <div class="card attachments-card no-print" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>Attachments</h2><p>${attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : esc(hint)}</p></div>
        <button class="btn btn-secondary btn-sm" data-action="upload-attachment">${icon('plus', 14)} Add file</button>
        <input type="file" hidden data-attachment-input accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.xls,.xlsx,.doc,.docx">
      </div>
      <div class="card-body" data-attachment-list>${attachmentListHtml(attachments)}</div>
    </div>
  `;
}

export function bindAttachmentSection(container, { entityType, entityId }) {
  const card = container.querySelector('.attachments-card');
  if (!card) return;
  const input = card.querySelector('[data-attachment-input]');
  const list = card.querySelector('[data-attachment-list]');
  const uploadButton = card.querySelector('[data-action="upload-attachment"]');

  async function reload() {
    const attachments = await loadAttachments(entityType, entityId);
    list.innerHTML = attachmentListHtml(attachments);
  }

  uploadButton.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast('Attachments must be 15 MB or smaller', 'error');
      return;
    }
    uploadButton.disabled = true;
    try {
      const query = new URLSearchParams({
        entity_type: entityType,
        entity_id: String(entityId),
        filename: file.name,
        type: file.type || 'application/octet-stream',
      });
      const response = await fetch(`/api/attachments?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
      if (!response.ok) throw new Error(data?.error || 'Could not upload attachment');
      toast(`${file.name} attached`);
      await reload();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      uploadButton.disabled = false;
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-attachment]');
    if (!button) return;
    const confirmed = await confirmDialog({
      title: 'Remove this attachment?',
      message: 'The file will be deleted from local storage.',
      confirmLabel: 'Remove file',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.del(`/attachments/${button.dataset.deleteAttachment}`);
      toast('Attachment removed');
      await reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

function attachmentListHtml(attachments) {
  if (!attachments.length) {
    return '<div class="attachment-empty">No files attached yet.</div>';
  }
  return `
    <div class="attachment-list">
      ${attachments.map((attachment) => `
        <div class="attachment-row">
          <div class="attachment-icon">${icon('file', 17)}</div>
          <div class="attachment-meta">
            <a href="${esc(attachment.download_url)}" target="_blank" rel="noopener">${esc(attachment.file_name)}</a>
            <span>${esc(fileSize(attachment.size_bytes))} · ${esc(fmtDate(String(attachment.created_at).slice(0, 10)))}</span>
          </div>
          <button class="icon-btn danger" data-delete-attachment="${attachment.id}" title="Remove attachment">${icon('trash', 15)}</button>
        </div>
      `).join('')}
    </div>
  `;
}

function fileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
