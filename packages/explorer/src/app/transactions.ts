import { useEffect, useState } from "react";

import type { Transaction } from "../shared/protocol.js";
import { call } from "./client.js";

/** Transactions never change once committed, so one cache serves every part. */
const cache = new Map<string, Promise<Transaction | null>>();

export const transaction = (txId: string): Promise<Transaction | null> => {
  let found = cache.get(txId);
  if (found === undefined) {
    found = call({ _tag: "Transaction", txId });
    cache.set(txId, found);
    found.catch(() => cache.delete(txId));
  }
  return found;
};

export const remember = (tx: Transaction) => {
  if (!cache.has(tx.txId)) cache.set(tx.txId, Promise.resolve(tx));
};

export function useTransaction(txId: string | null | undefined): Transaction | null {
  const [tx, setTx] = useState<Transaction | null>(null);
  useEffect(() => {
    if (!txId) {
      setTx(null);
      return;
    }
    let current = true;
    setTx(null);
    transaction(txId).then(
      (found) => current && setTx(found),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [txId]);
  return tx;
}
