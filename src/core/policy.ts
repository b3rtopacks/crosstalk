// First-run hop safety. A fresh install defaults to 2 hops; AUTO SEND with more than 2 hops needs an explicit,
// one-time confirmation (remembered afterwards, so an experienced user's own choice is never silently reset).

export const SAFE_MAX_HOPS = 2;

export interface HopPolicyInput {
  autoSend: boolean;
  maxHops: number;
  /** The user has previously confirmed running AUTO SEND with more than SAFE_MAX_HOPS. */
  alreadyConfirmed: boolean;
  /** The request carries an explicit confirmation for this action. */
  confirm: boolean;
}

export interface HopPolicyResult {
  ok: boolean;
  /** True if the caller must ask the user to confirm and retry with confirm=true. */
  requiresConfirmation: boolean;
  /** True if this request's confirmation should be remembered. */
  remember: boolean;
  message: string;
}

export function checkHopPolicy(i: HopPolicyInput): HopPolicyResult {
  if (!i.autoSend || i.maxHops <= SAFE_MAX_HOPS || i.alreadyConfirmed) {
    return { ok: true, requiresConfirmation: false, remember: false, message: '' };
  }
  if (i.confirm) return { ok: true, requiresConfirmation: false, remember: true, message: '' };
  return {
    ok: false, requiresConfirmation: true, remember: false,
    message: `AUTO SEND with MAX HOPS ${i.maxHops} (more than ${SAFE_MAX_HOPS}) will keep both assistants talking and spend usage until the limit. Confirm to continue.`,
  };
}
