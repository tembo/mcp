export function normalizeOpenApi(source: unknown): unknown {
  const spec = structuredClone(source);
  if (!spec || typeof spec !== 'object' || !('paths' in spec) || !spec.paths || typeof spec.paths !== 'object') return spec;
  for (const path of Object.values(spec.paths)) {
    if (!path || typeof path !== 'object') continue;
    for (const operation of Object.values(path)) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      operation.responses = omitTimestampDefaults(operation.responses);
    }
  }
  return spec;
}

function omitTimestampDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitTimestampDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === 'default' && typeof child === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(child)) return [];
    return [[key, ['example', 'examples', 'enum', 'const', 'default'].includes(key) ? child : omitTimestampDefaults(child)]];
  }));
}
