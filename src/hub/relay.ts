import { AdapterError, type ConversationAdapter } from '../shared/types.ts';
import { fingerprint } from '../shared/text.ts';

export interface RelayOutcome {
  from: string;
  to: string;
  chars: number;
  fingerprint: string;
  verified: boolean;
  exact: boolean;
  sendEnabled: boolean | null;
}

/**
 * One manual hop: read the newest COMPLETED reply from `src`, insert it into `dst`'s composer, verify by
 * read-back. Never submits. (The controlled automatic relay is src/core/machine.ts.)
 */
export async function relayOnce(src: ConversationAdapter, dst: ConversationAdapter, opts: { overwrite: boolean }): Promise<RelayOutcome> {
  const s = await src.getState();
  if (!s.ready) throw new AdapterError('source-not-ready', s.warning ?? `${src.id} is not ready`);
  if (s.generating) throw new AdapterError('source-generating', `${src.id} is still generating a reply`);
  const d = await dst.getState();
  if (!d.ready) throw new AdapterError('destination-not-ready', d.warning ?? `${dst.id} is not ready`);
  if (d.generating) throw new AdapterError('destination-generating', `${dst.id} is generating; wait for it to finish`);

  const latest = await src.readLatest();
  const res = await dst.insert(latest.text, opts);
  if (!res.verified) throw new AdapterError('verify-failed', 'Inserted text did not read back correctly');
  return {
    from: src.id, to: dst.id, chars: latest.text.length, fingerprint: fingerprint(latest.text),
    verified: res.verified, exact: res.exact, sendEnabled: res.sendEnabled,
  };
}
