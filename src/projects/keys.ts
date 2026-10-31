/** The browser is a device cache, not an authority for account ownership. */
let localAccount: string | null = null;
export const LEGACY_WORKSPACE_STORAGE_KEY = 'grava-simples-workspace-v1';
export let WORKSPACE_STORAGE_KEY = LEGACY_WORKSPACE_STORAGE_KEY;

export function setLocalAccount(userId: string | null): void {
  if (userId !== null && !/^user_[\w-]{1,160}$/.test(userId)) throw new Error('Conta local inválida.');
  localAccount = userId;
  WORKSPACE_STORAGE_KEY = scopedLocalKey(LEGACY_WORKSPACE_STORAGE_KEY);
}
export function getLocalAccount(): string | null { return localAccount; }
export function scopedStorageName(base: string, account: string | null = localAccount): string {
  return account ? `${base}:account:${account}` : base;
}
export const scopedLocalKey = scopedStorageName;
export function assertLocalAccount(account: string | null): void {
  if (localAccount !== account) throw new DOMException('A conta mudou. Abra a gravação novamente.', 'AbortError');
}
