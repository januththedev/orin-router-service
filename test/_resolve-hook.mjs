/** Test-only resolver: map `./x.js` → `./x.ts` for type-stripped sources. */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (typeof specifier === 'string' && specifier.endsWith('.js')) {
      return await next(specifier.slice(0, -3) + '.ts', context);
    }
    throw e;
  }
}
