import { renderPartyView } from './parties.js';

export function render(container, { query } = {}) {
  return renderPartyView(container, { query, kind: 'vendor' });
}
