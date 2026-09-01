import { CAPABILITY_NAMES, type CapabilityDefinition, type CapabilityDescriptor, type CapabilityName } from './types.js';

/**
 * The erased runtime shape of any capability. The registry and executor treat
 * capabilities structurally: input flows through the definition's own zod
 * schema (so type safety is enforced at the boundary, not in the registry),
 * and the executor's generic pipeline drives the rest.
 */
export interface AnyCapabilityDefinition {
  readonly name: CapabilityName;
  readonly inputSchema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown[] } } };
  readonly confirmation: 'none' | 'confirm' | 'confirm_destructive';
  readonly transactional: true;
  authorize(ctx: unknown, input: unknown, client: unknown): Promise<readonly unknown[]>;
  readonly prepare?: (ctx: unknown, input: unknown) => Promise<unknown>;
  execute(ctx: unknown, input: unknown, refs: readonly unknown[], tx: unknown, prepared: unknown): Promise<unknown>;
  readonly postCommit?: (ctx: unknown, input: unknown, result: unknown) => Promise<void>;
  readonly describe: { purpose: string; arguments: string };
}

/** Erase a concrete definition for registry storage. */
export function asAny<I, S, P>(definition: CapabilityDefinition<I, S, P>): AnyCapabilityDefinition {
  return definition as unknown as AnyCapabilityDefinition;
}

/**
 * The Capability Registry — one explicit, static, server-side composition.
 *
 * Registrations happen only in src/capabilities/index.ts (the composition
 * root). Duplicate names fail at registration time, which for the production
 * root means at boot. There is no dynamic loading: a capability name is a
 * mechanic, and neither the model nor the user can register, rename, or
 * rewire one.
 */
export class CapabilityRegistry {
  private readonly definitions = new Map<CapabilityName, AnyCapabilityDefinition>();

  register(definition: AnyCapabilityDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Capability "${definition.name}" is already registered`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: CapabilityName): AnyCapabilityDefinition | undefined {
    return this.definitions.get(name);
  }

  require(name: CapabilityName): AnyCapabilityDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Capability "${name}" is not registered`);
    return definition;
  }

  list(): readonly CapabilityDescriptor[] {
    return [...this.definitions.values()].map((def) => ({
      name: def.name,
      purpose: def.describe.purpose,
      arguments: def.describe.arguments,
      confirmation: def.confirmation,
    }));
  }

  get size(): number {
    return this.definitions.size;
  }
}

/** The production registry. Inspectable and testable; never user-populated. */
export const capabilityRegistry = new CapabilityRegistry();

/** All registered names — for tests and diagnostics. */
export function registeredCapabilityNames(): readonly CapabilityName[] {
  return CAPABILITY_NAMES.filter((name) => capabilityRegistry.get(name) !== undefined);
}

/** Register a concretely typed definition at the composition boundary. */
export function registerCapability<I, S, P>(definition: CapabilityDefinition<I, S, P>): void {
  capabilityRegistry.register(asAny(definition));
}
