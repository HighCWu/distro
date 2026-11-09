// SPDX-License-Identifier: MIT

export type DylinkAddressObject = {
  id: string;
  base: bigint;
  memorySize: bigint;
  dataSymbols: ReadonlyArray<{ name: string; address: bigint }>;
};

export type DylinkAddressFunction = {
  owner: string;
  symbol?: { name: string; address: bigint };
};

/** Resolve an address using known object ranges and exact exported symbols.
 * Function ownership must come from the caller's verified table lookup. */
export function resolve_dylink_address(
  address: bigint,
  objects: ReadonlyArray<DylinkAddressObject>,
  functionMatch?: DylinkAddressFunction,
): { owner: string; symbol?: { name: string; address: bigint } } | undefined {
  if (address <= 0n) return undefined;

  const owners = new Set<string>();
  if (functionMatch) owners.add(functionMatch.owner);

  let hasDataMatch = false;
  let exactDataSymbol: { name: string; address: bigint } | undefined;
  for (const object of objects) {
    let exactSymbol: { name: string; address: bigint } | undefined;
    for (const symbol of object.dataSymbols) {
      if (symbol.address !== address) continue;
      if (!exactSymbol || symbol.name < exactSymbol.name) exactSymbol = symbol;
    }

    const inMemory =
      object.memorySize > 0n && address >= object.base && address < object.base + object.memorySize;
    if (!exactSymbol && !inMemory) continue;

    hasDataMatch = true;
    owners.add(object.id);
    if (exactSymbol && (!exactDataSymbol || exactSymbol.name < exactDataSymbol.name))
      exactDataSymbol = exactSymbol;
  }

  if (owners.size !== 1) return undefined;
  const owner = owners.values().next().value;
  if (owner === undefined) return undefined;

  if (functionMatch?.owner === owner) {
    if (hasDataMatch) return { owner };
    return functionMatch.symbol ? { owner, symbol: functionMatch.symbol } : { owner };
  }

  if (exactDataSymbol) return { owner, symbol: exactDataSymbol };
  return { owner };
}
