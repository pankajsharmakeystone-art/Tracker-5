import type { Role, UserData } from '../types';

export const getUserRoles = (user?: Partial<UserData> | null): Role[] => {
  if (!user) return [];
  const fromArray = Array.isArray((user as any).roles) ? ((user as any).roles as Role[]) : [];
  const normalized = new Set<Role>();
  fromArray.forEach((r) => {
    if (r === 'admin' || r === 'manager' || r === 'agent') normalized.add(r);
  });
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'agent') {
    normalized.add(user.role);
  }
  return Array.from(normalized);
};

export const hasRole = (user: Partial<UserData> | null | undefined, role: Role): boolean => {
  return getUserRoles(user).includes(role);
};

export const getPrimaryRole = (user?: Partial<UserData> | null): Role | null => {
  const roles = getUserRoles(user);
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('manager')) return 'manager';
  if (roles.includes('agent')) return 'agent';
  return null;
};

export const getDisplayRole = (user?: Partial<UserData> | null): string => {
  const roles = getUserRoles(user);
  if (!roles.length) return 'unknown';
  const order: Role[] = ['admin', 'manager', 'agent'];
  const ordered = order.filter((r) => roles.includes(r));
  return ordered.join(' + ');
};
