// Who may open the Control Center and manage its editors: admins (the owner role) only.
export const isAdmin = (role: string) => role === 'owner';
