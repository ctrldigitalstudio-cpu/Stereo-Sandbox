// Node module hook: resolve src/worker.js's './worldgen.js' to the synthetic generator, so the worker
// protocol can be tested independently of the real generator.
//   node --import ./tools/tests/mesher/stub-worldgen-hook.mjs tools/tests/mesher/worker.test.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
const stub = ${JSON.stringify(new URL('./synth-worldgen.js', import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier === './worldgen.js' && context.parentURL && context.parentURL.endsWith('/src/worker.js')) {
    return { url: stub, shortCircuit: true };
  }
  return next(specifier, context);
}
`));
