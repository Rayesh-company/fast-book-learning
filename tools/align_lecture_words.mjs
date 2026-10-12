#!/usr/bin/env node
/** Offline, resumable CPU inference. Reads a manifest prepared by the Python
 * geometry builder; never sends audio to a service or downloads a model. */
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createAlignmentModel} from '../ui/narration/model.mjs';
import {normalizeUtterance} from '../ui/narration/aligner.mjs';
import {alignWords,orderedWords,WORD_ALIGNMENT_VERSION} from './lecture-word-alignment.mjs';

const [manifestPath,modelPath,outputPath,cacheDir]=process.argv.slice(2);
if(!cacheDir) throw new Error('Usage: node tools/align_lecture_words.mjs MANIFEST MODEL OUTPUT CACHE');
const manifestBytes=await readFile(manifestPath);
const manifest=JSON.parse(manifestBytes);
const pcm=await readFile(manifest.pcm);
const model=await createAlignmentModel(modelPath);
await mkdir(cacheDir,{recursive:true});
// Geometry and transcript edits must not rerun expensive audio inference.
// Key only the actual PCM, model, and acoustic preprocessing/window contract.
const identity=createHash('sha256').update(pcm).update(model.modelIdentity).update('normalized-16k-w12-p2-v1').digest('hex');
const duration=pcm.length/32000, window=12, padding=2;
const verified=[];let processed=0;
try {
  for(let core=0;core<duration;core+=window) {
    const coreEnd=Math.min(duration,core+window);
    const offset=Math.max(0,core-padding),end=Math.min(duration,coreEnd+padding);
    const words=manifest.words.filter(w=>w.coarse_end>=offset-16 && w.coarse_start<=end+16);
    if(!words.length) continue;
    const target=join(cacheDir,`${identity}-${core}.f32`);
    let data;
    try {data=await readFile(target);} catch(error) {
      if(error.code!=='ENOENT') throw error;
      const input=Float32Array.from({length:Math.floor((end-offset)*16000)},(_,i)=>pcm.readInt16LE(Math.floor(offset*16000+i)*2)/32768);
      const r=await model.compute(normalizeUtterance(input));
      data=Buffer.from(r.logits.buffer,r.logits.byteOffset,r.logits.byteLength);
      await writeFile(`${target}.tmp`,data);await rename(`${target}.tmp`,target);
    }
    const expectedFrames=Math.floor((Math.floor((end-offset)*16000)-400)/320)+1;
    if(data.length!==expectedFrames*268) throw new Error(`Truncated emissions: ${target}`);
    const logits=new Float32Array(data.buffer,data.byteOffset,data.byteLength/4);
    if(logits.some(v=>!Number.isFinite(v))) throw new Error(`Invalid emissions: ${target}`);
    const result=alignWords(words,{logits,vocabSize:67,frameCount:logits.length/67},offset,core,coreEnd);
    verified.push(...result.words);
    processed++;
    if(processed%50===0) console.log(`session ${manifest.session}: ${Math.round(coreEnd)}/${Math.round(duration)} seconds, ${verified.length} acoustic words`);
  }
  // Different context windows must agree on order too. Reject contradictory
  // observations rather than trimming them into fabricated word timings.
  const {words:monotonic,rejected}=orderedWords(verified);
  await writeFile(`${outputPath}.tmp`,JSON.stringify({version:WORD_ALIGNMENT_VERSION,model:model.modelIdentity,
    audio_sha256:manifest.audio_sha256,manifest_sha256:createHash('sha256').update(manifestBytes).digest('hex'),
    session:manifest.session,duration,words:monotonic,rejected_order:rejected}));
  await rename(`${outputPath}.tmp`,outputPath);
  console.log(`session ${manifest.session}: complete, ${monotonic.length}/${manifest.words.length} supported words`);
} finally {await model.dispose();}
