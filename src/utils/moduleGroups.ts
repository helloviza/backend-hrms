export const MODULE_GROUP_MAP: Record<string, string[]> = {
  hrops: [
    'attendance', 'leaves', 'holidays',
    'leaveApprovals', 'orgChart', 'policies',
    'teamProfiles', 'teamPresence', 'teamCalendar',
    'hrWorkspace', 'holidayManagement',
  ],
  payroll: ['payroll', 'payrollAdmin'],
  bookings: [
    'manualBookings', 'invoices', 'adminQueue',
    'reports', 'adminVouchers', 'voucherExtract',
    'companySettings', 'workspaceSettings',
  ],
  sbt: ['sbt', 'sbtSearch', 'sbtBookings', 'sbtRequest', 'travelSpend'],
  approvals: ['approvals'],
  people: ['people', 'masterData', 'onboarding'],
  access: ['accessConsole'],
  analytics: ['analytics'],
  crm: ['leads', 'crmContacts', 'crmCompanies'],
  vendor: ['vendorProfile'],
  operations: ['supportTickets', 'tasks', 'directCustomers'],
}
