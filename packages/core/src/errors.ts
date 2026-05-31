export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

export function readText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function requireInputText(value: unknown, message: string): string {
  const text = readText(value);
  if (!text) throw new Error(message);
  return text;
}
