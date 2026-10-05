import {z} from "zod";

/** Bounded MCP form subset. Unsupported constraints are rejected rather than silently discarded. */
export function nativeFormSchema(input: unknown): z.ZodType {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 32 * 1024) throw new Error("Native form schema exceeds its transport limit.");
  const property = z.object({type: z.enum(["string", "number", "integer", "boolean"]), title: z.string().max(512).optional(),
    description: z.string().max(8192).optional(), enum: z.array(z.union([z.string().max(8192), z.number().finite(), z.boolean()])).min(1).max(64).optional(),
    minLength: z.number().int().nonnegative().max(8192).optional(), maxLength: z.number().int().nonnegative().max(8192).optional(),
    minimum: z.number().finite().optional(), maximum: z.number().finite().optional()}).strict();
  const source = z.object({type: z.literal("object"), properties: z.record(z.string().min(1).max(128), property),
    required: z.array(z.string()).max(32).optional(), additionalProperties: z.literal(false).optional(),
    title: z.string().max(512).optional(), description: z.string().max(8192).optional()}).strict().parse(input);
  const names = Object.keys(source.properties);
  if (!names.length || names.length > 32 || names.some(name => ["__proto__", "constructor", "prototype"].includes(name)) || new Set(source.required ?? []).size !== (source.required ?? []).length
      || source.required?.some(name => !names.includes(name))) throw new Error("Unsupported native form fields.");
  const fields: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>;
  for (const [name, field] of Object.entries(source.properties)) {
    let schema: z.ZodType;
    if (field.type === "string") {
      if (field.minimum !== undefined || field.maximum !== undefined || (field.minLength ?? 0) > (field.maxLength ?? 8192)) throw new Error("Invalid native string constraints.");
      schema = z.string().min(field.minLength ?? 0).max(field.maxLength ?? 8192);
    } else if (field.type === "boolean") {
      if (field.minLength !== undefined || field.maxLength !== undefined || field.minimum !== undefined || field.maximum !== undefined) throw new Error("Invalid native boolean constraints.");
      schema = z.boolean();
    } else {
      if (field.minLength !== undefined || field.maxLength !== undefined || (field.minimum ?? -Infinity) > (field.maximum ?? Infinity)) throw new Error("Invalid native numeric constraints.");
      let number = field.type === "integer" ? z.number().int() : z.number().finite();
      if (field.minimum !== undefined) number = number.min(field.minimum);
      if (field.maximum !== undefined) number = number.max(field.maximum);
      schema = number;
    }
    if (field.enum) {
      if (field.enum.some(value => !schema.safeParse(value).success)) throw new Error("Invalid native form enumeration.");
      schema = z.intersection(schema, z.union(field.enum.map(value => z.literal(value))));
    }
    if (field.description) schema = schema.describe(field.description);
    fields[name] = source.required?.includes(name) ? schema : schema.optional();
  }
  return z.object(fields).strict();
}
