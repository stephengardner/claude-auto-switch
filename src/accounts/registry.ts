import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { RegistryError } from '../util/errors.js';
import { RegistrySchema, type Account, type Registry } from './registry.schema.js';

const FILENAME = 'accounts.json';

export function registryFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), FILENAME);
}

export function loadRegistry(c: PathCtx = {}): Registry {
  return readJsonFile(registryFilePath(c), RegistrySchema) ?? { accounts: [] };
}

export function saveRegistry(registry: Registry, c: PathCtx = {}): void {
  writeJsonFile(registryFilePath(c), registry);
}

export function listAccounts(c: PathCtx = {}): Account[] {
  return loadRegistry(c).accounts;
}

export function getAccount(name: string, c: PathCtx = {}): Account | undefined {
  return loadRegistry(c).accounts.find((a) => a.name === name);
}

export interface AddAccountInput {
  name: string;
  dir: string;
  priority?: number;
  enabled?: boolean;
  plan?: string;
  email?: string;
  browserProfile?: string;
}

/** Register a new account. Throws RegistryError if the name already exists. */
export function addAccount(input: AddAccountInput, c: PathCtx = {}): Account {
  const registry = loadRegistry(c);
  if (registry.accounts.some((a) => a.name === input.name)) {
    throw new RegistryError(`account "${input.name}" already exists`);
  }
  const account: Account = {
    name: input.name,
    dir: input.dir,
    priority: input.priority ?? nextPriority(registry),
    enabled: input.enabled ?? true,
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.browserProfile !== undefined ? { browserProfile: input.browserProfile } : {}),
  };
  registry.accounts.push(account);
  saveRegistry(registry, c);
  return account;
}

/** Patch an account in place. The name is immutable. Throws if not found. */
export function updateAccount(name: string, patch: Partial<Account>, c: PathCtx = {}): Account {
  const registry = loadRegistry(c);
  const account = registry.accounts.find((a) => a.name === name);
  if (!account) throw new RegistryError(`account "${name}" not found`);
  Object.assign(account, patch, { name: account.name });
  saveRegistry(registry, c);
  return account;
}

/** Deregister an account. Throws if not found. Does not touch its profile folder. */
export function removeAccount(name: string, c: PathCtx = {}): void {
  const registry = loadRegistry(c);
  const before = registry.accounts.length;
  registry.accounts = registry.accounts.filter((a) => a.name !== name);
  if (registry.accounts.length === before) {
    throw new RegistryError(`account "${name}" not found`);
  }
  saveRegistry(registry, c);
}

/** Next append-order priority: one past the current maximum (0 when empty). */
function nextPriority(registry: Registry): number {
  return registry.accounts.reduce((max, a) => Math.max(max, a.priority + 1), 0);
}
