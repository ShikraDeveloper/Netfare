// Email and WhatsApp links for sending a document from the user's own mail or
// WhatsApp app. Kept free of browser imports so tests can load it directly.

// wa.me wants the number in international form, digits only. UAE numbers are
// often saved locally (050 123 4567); those get the 971 country code.
export function whatsappNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 10) digits = `971${digits.slice(1)}`;
  return digits.length >= 8 ? digits : '';
}

export function whatsappUrl(phone, text) {
  const number = whatsappNumber(phone);
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

export function mailtoUrl(email, subject, body) {
  const to = String(email || '').trim();
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// The message sent with an invoice. `format` turns cents into "AED 1,250.00"
// and `date` turns an ISO date into a readable one.
export function invoiceMessage(invoice, { company = '', companyPhone = '', title = 'Invoice', format, date }) {
  const source = invoice.booking_number
    ? ` for booking ${invoice.booking_number}${invoice.booking_destination ? ` (${invoice.booking_destination})` : ''}`
    : invoice.visa_number ? ` for visa ${invoice.visa_number}` : '';
  const lines = [
    `Dear ${invoice.customer_name || 'customer'},`,
    '',
    `Please find ${title.toLowerCase()} ${invoice.number}${source}, dated ${date(invoice.issue_date)}.`,
    `Total: ${format(invoice.total_cents)}`,
  ];
  if (invoice.status_display === 'paid') {
    lines.push('This invoice is fully paid. Thank you.');
  } else if (invoice.balance_cents > 0) {
    lines.push(`Amount due: ${format(invoice.balance_cents)} by ${date(invoice.due_date)}.`);
    if (invoice.payment_link) lines.push(`Pay online by card: ${invoice.payment_link}`);
  }
  lines.push('', 'Thank you,', company, companyPhone);
  return lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n').trim();
}
