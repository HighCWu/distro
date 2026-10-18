// SPDX-License-Identifier: MIT
// Private build-time fault seam. No boot option, environment variable or UAPI.
export const copy_fault_test = false;
export type CopyFault = "initialize" | "allocate";

export function create_copy_fault_plan(): () => CopyFault | null {
  const plan: CopyFault[] = copy_fault_test ? ["initialize", "allocate"] : [];
  return () => plan.shift() ?? null;
}

export function inject_copy_fault(fault: CopyFault | undefined, stage: CopyFault): void {
  if (copy_fault_test && fault === stage) throw new Error(`injected copy ${stage} failure`);
}
