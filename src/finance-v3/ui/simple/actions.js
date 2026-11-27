// The quick actions shown on the Simple home screen. `needs` is the permission that must be held for the button to appear.
export const UI_ACTIONS = [
  { id: "create_invoice", label: "Create an invoice", needs: "finance.post" },
  { id: "send_invoice", label: "Send an invoice", needs: "finance.send_email", go: "invoices" },
  { id: "record_payment", label: "Record a client payment", needs: "finance.post" },
  { id: "add_expense", label: "Add an expense", needs: "finance.post" },
  { id: "record_work", label: "Record animator work", needs: "finance.post" },
  { id: "approve_work", label: "Approve animator work", needs: "finance.approve" },
  { id: "pay_animator", label: "Pay an animator", needs: "finance.pay" },
  { id: "pay_supplier", label: "Pay a supplier", needs: "finance.pay" },
  { id: "transfer", label: "Move money", needs: "finance.post" },
  { id: "add_reserve", label: "Add to reserve", needs: "finance.post" },
  { id: "owner_payment", label: "Record owner payment", needs: "finance.owner_pay" },
  { id: "project_profit", label: "View project profit", needs: "finance.read", go: "projects" },
];
