const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|cookie|token|access[-_.]?token|refresh[-_.]?token|api[-_.]?key|secret|password|passwd|credential|session)([-_.]|$)/i;
const AUTH_VALUE_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNMENT_VALUE_PATTERN = /\b(token|access_token|refresh_token|api_key|apikey|secret|password)=([^&\s]+)/gi;

type JsonRecord = Record<string, unknown>;

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactString(value);
  }
  return redacted;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown): unknown => redactValue(item));
  }

  if (isPlainRecord(value)) {
    const redacted: JsonRecord = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? REDACTED : redactValue(nestedValue);
    }
    return redacted;
  }

  return value;
}

function redactString(value: string): string {
  return value.replace(AUTH_VALUE_PATTERN, `$1 ${REDACTED}`).replace(ASSIGNMENT_VALUE_PATTERN, `$1=${REDACTED}`);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

