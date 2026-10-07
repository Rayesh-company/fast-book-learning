/** Optional local Persian wav2vec2 model; never downloads a model. */
import {access} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
export async function createAlignmentModel(path) {
  if (!path) return null;
  await access(path);
  const digest=createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const modelIdentity=`wav2vec2-persian:${digest.digest('hex')}`;
  const ort = await (await import('./alignment/runtime.mjs')).loadOnnxRuntime();
  const session = await ort.InferenceSession.create(path, {executionProviders:['cpu'],graphOptimizationLevel:'all',intraOpNumThreads:Math.max(1,Math.floor((await import('node:os')).cpus().length/2))});
  return {
    inputSampleRate:16000,
    modelIdentity,
    async compute(input) {
      const outputs = await session.run({input_values:new ort.Tensor('float32',input,[1,input.length])});
      const logits=outputs.logits ?? outputs[session.outputNames[0]];
      if (!logits || logits.dims.length!==3 || logits.dims[0]!==1 || logits.dims[2]!==67) throw new Error('Unexpected Persian alignment model output');
      return {frameRateHz:50,frameCount:logits.dims[1],vocabSize:logits.dims[2],logits:logits.data};
    },
    async dispose() {await session.release();},
  };
}
