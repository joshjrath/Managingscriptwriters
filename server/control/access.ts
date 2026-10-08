// Who may use the admin-only parts (editors, the colour palette): admins (the owner role) only.
export const isAdmin = (role: string) => role === 'owner';
