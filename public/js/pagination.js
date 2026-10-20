export const DEFAULT_PAGE_SIZE = 25;

const PAGE_SIZES = [10, 25, 50, 100];

export function paginationHtml({ total, page, pageSize = DEFAULT_PAGE_SIZE }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = total ? (current - 1) * pageSize + 1 : 0;
  const end = Math.min(current * pageSize, total);
  return `
    <div class="pagination" data-pagination data-page="${current}" role="navigation" aria-label="Pagination">
      <div class="pagination-info" aria-live="polite">${start}–${end} of ${total}</div>
      <label class="pagination-size">
        <span>Rows</span>
        <select class="input" data-page-size aria-label="Rows per page">
          ${PAGE_SIZES.map((size) => `<option value="${size}" ${size === pageSize ? 'selected' : ''}>${size}</option>`).join('')}
        </select>
      </label>
      <div class="pagination-controls">
        <button type="button" class="btn btn-ghost btn-sm" data-page-prev ${current <= 1 ? 'disabled' : ''} aria-label="Previous page">Previous</button>
        <span class="pagination-page">Page ${current} of ${pages}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-page-next ${current >= pages ? 'disabled' : ''} aria-label="Next page">Next</button>
      </div>
    </div>
  `;
}

export function bindPagination(root, onChange) {
  if (!root) return;
  const currentPage = Number(root.dataset.page) || 1;
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page-prev], [data-page-next]');
    if (!button || button.disabled) return;
    const size = Number(root.querySelector('[data-page-size]')?.value) || DEFAULT_PAGE_SIZE;
    onChange({
      page: button.hasAttribute('data-page-next') ? currentPage + 1 : Math.max(1, currentPage - 1),
      pageSize: size,
    });
  });
  root.addEventListener('change', (event) => {
    if (!event.target.matches('[data-page-size]')) return;
    onChange({ page: 1, pageSize: Number(event.target.value) || DEFAULT_PAGE_SIZE });
  });
}
