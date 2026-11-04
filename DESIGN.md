# Netfare design

Simple purpose, simple layout, simple code. Read this before adding or changing a screen.

## Rules

1. **One screen, one job.** The thing people came for (an amount, a status, the next step) is first and largest.
2. **No taglines, hints or secondary labels.** If a screen needs one to make sense, change the layout:
   - a clearer label;
   - a sensible default;
   - hide what does not apply;
   - put related things together;
   - a switch instead of an explanation.

   `npm run check` fails when a browser file gains helper text (`scripts/copy-budget.js`). After removing some, run `node scripts/copy-budget.js --write` to lower the budget.
3. **What stays:** error messages, amounts, dates, statuses, and warnings that protect money or data, for example "this can't be undone".
4. **One main action per screen.** Everything else goes in the More menu (`moreMenuHtml`). Creating something starts from the one New menu (`newMenuHtml`).
5. **Show detail on demand.** Secondary sections fold to one line with a count (`foldHtml`) and open on click.
6. **Same piece, same look.** Use the components below. Add a new component here before using it on a second screen.
7. **Nothing breaks.** Keep the selectors tests use (`data-*` attributes). Run `npm test`, `npm run test:e2e` and `npm run check`, and look at the screen in light and dark.

## Components (`public/js/ui.js`)

| Need | Use |
| --- | --- |
| Page title, status and actions | `setHeader({ title, badge, actions })`, with no subtitle |
| Extra actions | `moreMenuHtml(items)` |
| A secondary section | `foldHtml({ key, title, count, body, actions })`, stacked with `foldsHtml([...])` |
| Files on a record | `attachmentFoldHtml(...)` (`attachments.js`) |
| One choice out of a few | `segmentedHtml(name, options, selected)` |
| One number | `numberCardHtml({ label, cents, href, overdue })` in a `.kpi-grid` |
| Nothing to show | `emptyState({ title })`, with no message |
| Who made a record | `pageRecord(record)` (detail pages), `recordMetaHtml(record)` (forms) |

## Tokens

Colours, radius and shadows are CSS variables in `public/css/theme.css` (light and dark). Use `var(--text)`, `var(--muted)`, `var(--surface)`, `var(--border)`, `var(--red)` and so on; never a raw colour. The older `:root` block in `styles.css` is a fallback that `theme.css` overrides.

## Done so far

Phase 1, 2026-11-04: the Dashboard, the invoice page and the New invoice form. The other screens follow group by group.
