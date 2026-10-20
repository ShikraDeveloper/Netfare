import * as statementView from './statement.js';

export function render(container, context = {}) {
  return statementView.render(container, { ...context, kind: 'vendor' });
}
