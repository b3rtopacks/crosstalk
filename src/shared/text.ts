import { createHash } from 'node:crypto';

/** Collapse all whitespace so read-back comparison ignores paragraph/linebreak representation. */
export function normalize(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}

export function sameText(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/**
 * Layout-independent form of a reply, used ONLY for identity (dedupe, "is this still the same reply?").
 * Every non-whitespace character, in order, is kept; whitespace (and zero-width characters) is dropped, because the
 * adapters can only ever vary whitespace with incidental layout (paragraph vs inline joining from on-screen
 * positions, line wrapping, re-rendering). Any change to actual characters still changes the hash.
 */
export function canonical(s: string): string {
  return s.replace(/[\s ​-‍﻿]+/g, '');
}

/** SHA-256 (hex) of the canonical reply. */
export function fingerprint(s: string): string {
  return createHash('sha256').update(canonical(s)).digest('hex');
}

export interface TextDiff {
  same: boolean;
  /** Differ only in whitespace (canonical forms are equal). */
  whitespaceOnly: boolean;
  lengthA: number;
  lengthB: number;
  /** First differing index in the raw strings (-1 if identical). */
  rawIndex: number;
  /** First differing index in the canonical strings (-1 if identical). */
  canonicalIndex: number;
  /** Escaped context around the first canonical difference, from each side. */
  contextA: string;
  contextB: string;
}

const esc = (s: string): string => JSON.stringify(s).slice(1, -1);

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** Describe how two reads of "the same" reply differ (for diagnostics only). */
export function diffInfo(a: string, b: string, radius = 24): TextDiff {
  const ca = canonical(a), cb = canonical(b);
  const rawIndex = firstDiff(a, b);
  const canonicalIndex = firstDiff(ca, cb);
  const at = canonicalIndex < 0 ? 0 : canonicalIndex;
  const window = (c: string): string => esc(c.slice(Math.max(0, at - radius), at + radius));
  return {
    same: rawIndex < 0, whitespaceOnly: rawIndex >= 0 && canonicalIndex < 0, lengthA: a.length, lengthB: b.length,
    rawIndex, canonicalIndex, contextA: window(ca), contextB: window(cb),
  };
}
