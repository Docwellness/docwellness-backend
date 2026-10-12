/**
 * Default role / permission matrix for the admin panel
 * (openspec: admin-rbac-permissions). Pure data + helpers, no I/O.
 */
const RESOURCES = [
  'users',
  'dieticians',
  'payments',
  'sales',
  'partners',
  'placements',
  'content',
  'notifications',
  'reports',
  'roles',
  'audit',
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export', 'approve'];

const allPermissions = () => Object.fromEntries(RESOURCES.map((r) => [r, [...ACTIONS]]));

const DEFAULT_ROLES = [
  { name: 'super_admin', description: 'Full access', permissions: allPermissions() },
  {
    name: 'support',
    description: 'Users and dieticians, read reports',
    permissions: { users: ['view', 'edit'], dieticians: ['view'], reports: ['view'] },
  },
  {
    name: 'finance',
    description: 'Payments and sales',
    permissions: {
      payments: ['view', 'edit', 'approve', 'export'],
      sales: ['view', 'export'],
      reports: ['view', 'export'],
    },
  },
  {
    name: 'content',
    description: 'Content catalog and notifications',
    permissions: {
      content: ['view', 'create', 'edit', 'delete'],
      notifications: ['view', 'create'],
    },
  },
  {
    name: 'partnerships',
    description: 'Partner requests and product placements',
    permissions: {
      partners: ['view', 'create', 'edit', 'delete'],
      placements: ['view', 'create', 'edit', 'approve'],
    },
  },
  {
    name: 'viewer',
    description: 'Read-only',
    permissions: Object.fromEntries(
      RESOURCES.filter((r) => r !== 'roles' && r !== 'audit').map((r) => [r, ['view']])
    ),
  },
  // Reserved for a future manufacturer portal; cannot be assigned in v1.
  { name: 'partner', description: 'Reserved for a manufacturer portal', permissions: {}, assignable: false },
];

function can(permissions, resource, action) {
  const list = permissions && permissions[resource];
  return Array.isArray(list) && list.includes(action);
}

module.exports = { RESOURCES, ACTIONS, DEFAULT_ROLES, can };
