// What the help panel (help.js) can answer. Each topic:
//   area   - the right needed to see it (store.can); staff see only their areas
//   page   - the screens it belongs to (matched against the path, e.g. /invoices/12)
//   form   - the forms it belongs to (matched against the open form's title)
//   q      - the question as staff would ask it
//   words  - other English words people use for it (search reads q and words only)
//   steps  - the answer; **text** is a button or field name as it reads on screen
//   go     - a button on the page to point at ("Show me")
// Button and field names must match the screens; tests check the go selectors.
export const HELP_TOPICS = [
  // ---------- Bookings ----------
  {
    id: 'booking-new', area: 'bookings', page: /^\/bookings$/, form: /^New booking$/,
    q: 'How do I make a new booking?',
    words: 'booking ticket new create add passenger pnr hotel service fee insurance customer',
    steps: [
      'Open **Bookings** and press **New booking**.',
      'Choose the **Customer**. Type to search; if the name is not there, choose **Add new customer** at the end of the list.',
      'Fill the booking date, travel date, destination and PNR.',
      'Add one row per passenger: name, **Sale**, **Cost** and **Supplier**. The ticket number is behind **⋯** on the row.',
      'Use **Add other item** for a hotel, service fee or insurance.',
      'Save. The booking stays a draft until you press **Confirm & post**.',
    ],
    go: '[data-action="new-booking"]',
  },
  {
    id: 'booking-confirm', area: 'bookings', page: /^\/bookings\/\d+$/,
    q: 'How do I confirm and post this booking?',
    words: 'confirm post invoice bill final',
    steps: [
      'Press **Confirm & post**.',
      'A preview shows the customer invoice, one bill per supplier, and which bills a prepaid wallet pays, with the wallet balance before and after.',
      'Confirm. The invoice and bills are made in one step.',
      'If a wallet is short, it pays what it has and the rest stays payable: top up the portal and press **Settle** there.',
    ],
    go: '[data-action="confirm"]',
  },
  {
    id: 'booking-payment', area: 'bookings', page: /^\/bookings\/\d+$/,
    q: 'How do I take the customer\'s payment for this booking?',
    words: 'payment receive customer cash card bank advance',
    steps: [
      'After **Confirm & post**, press **Record payment**. It opens the booking\'s invoice; press **Record payment** there.',
      'Before confirming, take the money as an advance: **Record** in the Advances card. After confirming, press **Apply** to put it on the invoice.',
    ],
    go: '[data-action="record-advance"]',
  },
  {
    id: 'booking-cancel', area: 'bookings', page: /^\/bookings\/\d+$/,
    q: 'How do I cancel this booking?',
    words: 'cancel cancellation refund',
    steps: [
      'Press **Cancel booking**. You need the Cancel right; ask the admin if the button is missing.',
      'Enter the **Cancellation date** and the **Cancellation charges to customer**.',
      'Under **Supplier bills**, enter what each supplier gives back (**Supplier credit**).',
      'Save. Then choose **Pay refund**, **Convert to credit** or **Decide later**.',
    ],
    go: '[data-action="cancel"]',
  },
  {
    id: 'booking-edit', area: 'bookings', page: /^\/bookings(\/\d+)?$/,
    q: 'How do I change a booking?',
    words: 'edit change wrong correct update',
    steps: [
      'A draft: press **Edit**.',
      'After **Confirm & post**: **Edit details** changes things like travel date, PNR and notes. Amounts are changed with **Correct** (admin).',
    ],
    go: '[data-action="edit"], [data-action="edit-details"]',
  },
  {
    id: 'booking-travelled', area: 'bookings', page: /^\/bookings\/\d+$/,
    q: 'What does Mark travelled do?',
    words: 'travelled travel done complete',
    steps: [
      'When the trip is done, press **Mark travelled**. It closes the booking; it posts nothing.',
    ],
    go: '[data-action="travel"]',
  },
  {
    id: 'supplier-wallet-label', area: 'bookings', form: /^New booking$|^New visa application$/,
    q: 'Why does a supplier say "— wallet" or "— credit"?',
    words: 'wallet credit supplier portal label',
    steps: [
      '"— wallet": the supplier has a prepaid portal. On **Confirm & post** its bill is paid from the wallet.',
      '"— credit": the supplier has a credit account. The bill stays payable until you pay it from **Bills & expenses**.',
      'No label: no portal. The bill stays payable.',
    ],
  },

  // ---------- Visas ----------
  {
    id: 'visa-new', area: 'visas', page: /^\/visas$/, form: /^New visa application$/,
    q: 'How do I make a new visa application?',
    words: 'visa new create applicant passport',
    steps: [
      'Open **Visas** and press **New visa**.',
      'Choose the **Customer** who pays, the visa type, country and dates.',
      'Add one row per applicant with **Add applicant**: name, passport number and expiry, sale, cost and supplier. Nationality and date of birth are behind **⋯**.',
      'If you take a refundable deposit, enter it under **Security deposit**.',
      'Save. Each applicant gets its own application and invoice, linked as one group.',
    ],
    go: '[data-action="new-visa"]',
  },
  {
    id: 'visa-submit', area: 'visas', page: /^\/visas\/\d+$/,
    q: 'How do I submit and post this visa?',
    words: 'submit post invoice bill group all',
    steps: [
      'Press **Submit & post**. It makes the customer invoice and the supplier bills, like confirming a booking.',
      'In a group, **Submit all** submits every draft in the group at once.',
    ],
    go: '[data-action="submit"], [data-action="submit-group"]',
  },
  {
    id: 'visa-status', area: 'visas', page: /^\/visas\/\d+$/,
    q: 'How do I mark the visa approved, issued or rejected?',
    words: 'approved approve issued issue reject rejected status',
    steps: [
      '**Mark approved** and **Mark issued** only record the step; they post nothing.',
      '**Reject** reverses the invoice and supplier bills. If the embassy keeps its fee, record it as an expense.',
    ],
    go: '[data-action="approve"], [data-action="issue"], [data-action="reject"]',
  },
  {
    id: 'visa-deposit', area: 'visas', page: /^\/visas\/\d+$/,
    q: 'How do I take or return a security deposit?',
    words: 'security deposit guarantee take refund forfeit supplier returned',
    steps: [
      'In the **Security deposit** card press **Take deposit**. It is the customer\'s money, not a sale.',
      'If the supplier holds it: **Pay to supplier**, and later **Supplier returned**.',
      'Give it back with **Refund**, put it on the invoice with **Use for invoice**, or keep it with **Forfeit** (a reason is needed).',
    ],
    go: '[data-deposit-action]',
  },
  {
    id: 'visa-cancel', area: 'visas', page: /^\/visas\/\d+$/,
    q: 'How do I cancel this visa application?',
    words: 'cancel cancellation refund',
    steps: [
      'Press **Cancel application**. You need the Cancel right.',
      'Enter the date, the charges and what each supplier gives back, then save.',
      'Then choose **Pay refund**, **Convert to credit** or **Decide later**.',
    ],
    go: '[data-action="cancel"]',
  },

  // ---------- Invoices ----------
  {
    id: 'invoice-new', area: 'sales', page: /^\/invoices$/, form: /^New invoice$/,
    q: 'How do I make a new invoice?',
    words: 'invoice new create bill customer',
    steps: [
      'Booking and visa invoices are made for you on **Confirm & post** or **Submit & post**.',
      'For anything else: **Invoices** → **New invoice**, choose the customer, add the lines and save.',
      'A draft can still change. **Send & post** puts it in the books.',
    ],
    go: '[data-action="new-invoice"]',
  },
  {
    id: 'invoice-payment', area: 'sales', page: /^\/invoices\/\d+$/,
    q: 'How do I record a payment on this invoice?',
    words: 'payment receive cash card bank received',
    steps: [
      'Press **Record payment**.',
      'Enter the amount, the date (today or earlier) and how it was paid: cash, card or bank.',
      'Save. The invoice shows paid or partly paid.',
    ],
    go: '[data-action="payment"]',
  },
  {
    id: 'invoice-refund', area: 'sales', page: /^\/invoices\/\d+$/,
    q: 'How do I refund this invoice?',
    words: 'refund return give back money',
    steps: [
      'Go to **Payments** below the items.',
      'On the payment line press the ↑ **Refund payment** button.',
      'Enter the amount, date and where the money goes out (cash or bank). Save.',
      'No payment yet? Nothing to refund. For a booking or visa trip that is cancelled, cancel the booking or visa instead.',
      'Paid from an advance (the payment says **From advance**)? There is no ↑ button. Ask the admin to undo the advance on this invoice, then refund the advance from **Customer balances** → the customer → **Refund**.',
    ],
    go: '[data-refund-payment]',
  },
  {
    id: 'invoice-void', area: 'sales', page: /^\/invoices\/\d+$/,
    q: 'How do I cancel or delete this invoice?',
    words: 'void delete cancel wrong mistake',
    steps: [
      'A draft: **Delete draft**.',
      'From a booking or visa: cancel the booking or visa; that reverses the invoice.',
      'Any other posted invoice: **Void** (admin only). It stays in the books as voided.',
    ],
    go: '[data-action="delete"], [data-action="cancel-job"], [data-action="void"]',
  },
  {
    id: 'invoice-share', area: 'sales', page: /^\/invoices\/\d+$/,
    q: 'How do I send this invoice to the customer?',
    words: 'share whatsapp email pdf print send',
    steps: [
      'Press **Share**, then **WhatsApp**, **Email** or **PDF**.',
      '**Print** prints it on A4.',
    ],
    go: '[data-action="share"]',
  },
  {
    id: 'advance', area: 'sales', page: /^\/(invoices|customer-balances)/,
    q: 'How do I take money before the invoice (an advance)?',
    words: 'advance deposit receive payment apply',
    steps: [
      'On a booking or visa: **Record** in its Advances card, then **Apply** after posting.',
      'For a customer: **Customer balances** → the customer → **Record advance**.',
      '**Receive payment** there takes one payment and spreads it over the customer\'s open invoices.',
    ],
    go: '[data-action="record-advance"], [data-action="receive-payment"]',
  },

  // ---------- Bills ----------
  {
    id: 'bill-new', area: 'suppliers', page: /^\/bills$/, form: /^New bill$/,
    q: 'How do I enter a supplier bill?',
    words: 'bill supplier new create purchase',
    steps: [
      'Booking and visa bills are made for you on **Confirm & post** or **Submit & post**.',
      'For anything else: **Bills & expenses** → **New bill**, choose the supplier, add the lines and save.',
      '**Receive & post** puts the bill in the books.',
    ],
    go: '[data-action="new-bill"]',
  },
  {
    id: 'quick-expense', area: 'suppliers', page: /^\/bills$/, form: /^Quick expense$/,
    q: 'How do I record an expense like rent, fuel or tea?',
    words: 'expense rent fuel petrol tea salary office',
    steps: [
      'Press **Quick expense** on **Bills & expenses**.',
      'Enter what it was, the amount, the date and how it was paid. It is posted and paid in one step.',
    ],
    go: '[data-action="quick-expense"]',
  },
  {
    id: 'bill-pay', area: 'suppliers', page: /^\/bills\/\d+$/,
    q: 'How do I pay this bill?',
    words: 'pay payment supplier wallet bank',
    steps: [
      'Press **Record payment**, enter the amount, date and the account it is paid from.',
      'To pay it from a supplier\'s prepaid wallet, open the portal and press **Settle**.',
    ],
    go: '[data-action="payment"]',
  },
  {
    id: 'bill-refund', area: 'suppliers', page: /^\/bills\/\d+$/,
    q: 'The supplier gave money back. How do I record it?',
    words: 'refund supplier return credit back',
    steps: [
      'Money back for a payment: on the payment line press ↑ **Record supplier refund**.',
      'Money the supplier owes you but has not paid yet: **Supplier credit**.',
      'A payment made from a wallet goes back through the portal, not here.',
    ],
    go: '[data-refund-payment], [data-action="supplier-credit"]',
  },

  // ---------- Portals and wallets ----------
  {
    id: 'portal-new', area: 'portals', page: /^\/portals$/, form: /^New supplier portal$|^New supplier$/,
    q: 'How do I add a supplier portal or wallet?',
    words: 'portal wallet new create add supplier consolidator airline',
    steps: [
      'Open **Portals & wallets** and press **New portal**.',
      'Fill the name and type. **How you settle**: Prepaid wallet (top up first) or Credit account (pay later).',
      'Choose the **Linked supplier**. Its bills are paid from this portal.',
      'Adding a new supplier from a list? Tick **This supplier has a portal** to make both at once.',
    ],
    go: '[data-action="new-portal"]',
  },
  {
    id: 'portal-topup', area: 'portals', page: /^\/portals\/\d+$/,
    q: 'How do I top up this wallet?',
    words: 'top up topup recharge deposit add money wallet balance',
    steps: [
      'Press **Top up**.',
      'Enter the amount, date and the bank or cash it was paid from. Save.',
      'The money is still yours, held by the supplier, until a booking uses it.',
    ],
    go: '[data-action="topup"]',
  },
  {
    id: 'portal-settle', area: 'portals', page: /^\/portals\/\d+$/,
    q: 'How do I pay waiting bills from this wallet?',
    words: 'settle pay bill wallet short payable',
    steps: [
      'Bills the wallet could not pay show under **Supplier payable**.',
      'Top up first if needed, then press **Settle** and choose the bills.',
    ],
    go: '[data-action="settle"]',
  },
  {
    id: 'portal-withdraw', area: 'portals', page: /^\/portals\/\d+$/,
    q: 'The supplier returned wallet money. How do I record it?',
    words: 'withdraw refund return wallet money back',
    steps: [
      'Press **Withdraw**, enter the amount, date and the bank or cash it came into.',
      'You can withdraw up to the wallet balance.',
    ],
    go: '[data-action="withdraw"]',
  },
  {
    id: 'portal-reconcile', area: 'portals', page: /^\/portals\/\d+/,
    q: 'How do I check the wallet against the portal\'s statement?',
    words: 'reconcile statement match check compare',
    steps: [
      'On the portal page press **Reconcile**.',
      'Paste or load the statement from the supplier\'s portal, pick the date and amount columns, and compare.',
      'It lists what matches, what is missing here (with a button to record it) and what is not on the statement. It changes nothing by itself.',
    ],
  },

  // ---------- Refunds, cancellations and settlements ----------
  {
    id: 'cancellation-settle', area: 'refunds', page: /^\/cancellations\/\d+$/,
    q: 'How do I give the customer their money back after a cancellation?',
    words: 'refund pay credit cancellation settle decide later',
    steps: [
      '**Pay refund**: the money goes out from cash or bank.',
      '**Convert to credit**: the customer keeps it for a next booking.',
      '**Decide later** leaves it waiting; **Settlement options** opens the choice again.',
    ],
    go: '[data-action="refund"], [data-action="convert"], [data-action="settlement-options"]',
  },
  {
    id: 'refund-where', area: 'refunds', page: /^\/(refunds|settlement-queue|cancellations)/,
    q: 'Where do I make a refund?',
    words: 'refund return',
    steps: [
      'A payment on an invoice: the ↑ button on its payment line.',
      'A cancelled booking or visa: its cancellation page, **Pay refund**.',
      'Anything else: **Refunds** → **New refund**.',
      '**Settlements** lists everything still waiting: refunds, credits and advances.',
    ],
    go: '[data-action="new-refund"]',
  },
];
