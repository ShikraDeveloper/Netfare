import { api } from './api.js';
import { confirmDialog, esc, fmtDate, foldHtml, icon, toast } from './ui.js';

const MAX_BYTES = 15 * 1024 * 1024;

// Photos (passport and ID scans) are made smaller before upload: longest side
// 1600 px, saved as JPG. They are kept inside the books, so every backup
// carries them. PDFs, other files and photos already small go up unchanged.
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PHOTO_MAX_SIDE = 1600;
const PHOTO_SMALL_BYTES = 500 * 1024;

async function smallerPhoto(file) {
  if (!PHOTO_TYPES.includes(file.type)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= PHOTO_SMALL_BYTES) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; // a transparent PNG becomes white paper, not black
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], `${file.name.replace(/\.(png|webp|jpe?g)$/i, '')}.jpg`, { type: 'image/jpeg' });
}

export async function loadAttachments(entityType, entityId) {
  try {
    return await api.get('/attachments', { entity_type: entityType, entity_id: entityId });
  } catch {
    return [];
  }
}

export function attachmentSection({ entityType, entityId, attachments, hint = 'Tickets, receipts and supporting documents', title = 'Attachments' }) {
  return `
    <div class="card attachments-card no-print" style="margin-top:16px">
      <div class="card-head">
        <div class="card-title"><h2>${esc(title)}</h2><p>${attachments.length ? `${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : esc(hint)}</p></div>
        <button class="btn btn-secondary btn-sm" data-action="upload-attachment">${icon('plus', 14)} Add file</button>
        <input type="file" hidden data-attachment-input accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.xls,.xlsx,.doc,.docx">
      </div>
      <div class="card-body" data-attachment-list>${attachmentListHtml(attachments)}</div>
    </div>
  `;
}

// The same files as a fold row (ui.js foldHtml) inside a .folds card.
export function attachmentFoldHtml({ entityType, entityId, attachments, title = 'Attachments' }) {
  return foldHtml({
    key: 'attachments',
    title,
    count: attachments.length,
    body: `
      <div class="attachments-card">
        <div class="fold-actions">
          <button class="btn btn-secondary btn-sm" data-action="upload-attachment">${icon('plus', 14)} Add file</button>
        </div>
        <input type="file" hidden data-attachment-input accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.xls,.xlsx,.doc,.docx">
        <div data-attachment-list>${attachmentListHtml(attachments)}</div>
      </div>`,
  });
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
    const chosen = input.files?.[0];
    input.value = '';
    if (!chosen) return;
    const file = await smallerPhoto(chosen);
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
            ${attachment.preview_url
    ? `<a href="${esc(attachment.preview_url)}" target="_blank" rel="noopener" title="Open ${esc(attachment.file_name)}">${esc(attachment.file_name)}</a>`
    : `<a href="${esc(attachment.download_url)}" download="${esc(attachment.file_name)}" title="Download ${esc(attachment.file_name)}">${esc(attachment.file_name)}</a>`}
            <span>${esc(fileSize(attachment.size_bytes))} · ${esc(fmtDate(String(attachment.created_at).slice(0, 10)))}${attachment.uploaded_by ? ` · by ${esc(attachment.uploaded_by)}` : ''}</span>
          </div>
          <a class="icon-btn" href="${esc(attachment.download_url)}" download="${esc(attachment.file_name)}" title="Download" aria-label="Download ${esc(attachment.file_name)}">${icon('download', 15)}</a>
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
