/** Trusted process entry. Its input comes only from the Python Book authority. */
import {createAvalaiSpeechProvider} from './provider.mjs';
import {planParagraphSpans,planSentenceSpans} from './segmenter.mjs';
import {validateVariantForUnit} from './speech-variant.mjs';
import {reconcileVariantFormatting,mapCanonicalToVariant} from './diacritizer.mjs';
import {parseWavPcm,alignChunk} from './aligner.mjs';
import {sha256HexBytes} from './identity.mjs';
import {NarrationApiError} from './errors.mjs';
import {createAlignmentModel} from './model.mjs';
import {NARRATION_PROFILE,PROVIDER_MAX_AUDIO_BYTES} from './constants.mjs';
import {pathToFileURL} from 'node:url';

function stitch(parts) {
  if(parts.length===1) return parts[0].bytes;
  const rate=parts[0].wav.sampleRate;
  if(parts.some(part=>part.wav.sampleRate!==rate)) throw new NarrationApiError('NARRATION_AUDIO_INVALID','Inconsistent WAV sample rates');
  const count=parts.reduce((sum,part)=>sum+part.wav.samples.length,0);
  const bytes=Buffer.alloc(44+2*count);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(2*count,40);
  let offset=44;
  for(const part of parts) for(const sample of part.wav.samples) {bytes.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(sample*32768))),offset);offset+=2;}
  return bytes;
}

export async function generate(input) {
  const provider=createAvalaiSpeechProvider(input.providerOptions ?? {});
  if(provider.availability().status!=='available') throw new NarrationApiError('NARRATION_PROVIDER_NOT_CONFIGURED','Speech provider is not configured');
  let model=null,alignment={status:'unavailable',reason:'NARRATION_ALIGNMENT_UNAVAILABLE'};
  if(process.env.NARRATION_ALIGNMENT_MODEL) {
    try {model=await createAlignmentModel(process.env.NARRATION_ALIGNMENT_MODEL);alignment={status:'available'};}
    catch {alignment={status:'unavailable',reason:'NARRATION_ALIGNMENT_UNAVAILABLE'};}
  }
  const parts=[],cues=[];
  let durationMs=0,totalBytes=0;
  try {
    for(const paragraph of planParagraphSpans(input.text)) {
      const canonical=input.text.slice(paragraph.start,paragraph.end);
      let speech=null;
      for(let attempt=0;attempt<2;attempt++) {
        const candidate=(await provider.diacritize({jobRef:'book-narration',canonicalText:canonical,corrective:attempt===1})).candidate;
        const reconciled=reconcileVariantFormatting(canonical,candidate);
        if(reconciled!==null&&validateVariantForUnit(canonical,reconciled).ok) {speech=reconciled;break;}
      }
      if(speech===null) throw new NarrationApiError('NARRATION_DIACRITIZATION_INVALID','Speech variant changed the Book text or omitted vowelization');
      const map=mapCanonicalToVariant(canonical,speech);
      if(!map) throw new NarrationApiError('NARRATION_DIACRITIZATION_INVALID','Speech offsets cannot be mapped');
      const spans=planSentenceSpans(canonical);
      const chunkPlan=[{start:0,end:canonical.length,spans}];
      for(let ci=0;ci<chunkPlan.length;ci++) {
        const chunk=chunkPlan[ci];
        const slice=speech.slice(map[chunk.start],map[chunk.end]);
        let audio;
        try {audio=await provider.speak({speechText:slice,requestId:'book-narration'});}
        catch(error) {
          if(error.code==='NARRATION_INPUT_UNSUPPORTED'&&chunk.spans.length>1) {
            chunkPlan.splice(ci,1,...chunk.spans.map(span=>({start:span.start,end:span.end,spans:[span]})));ci--;continue;
          }
          throw error;
        }
        totalBytes+=audio.bytes.length;
        if(totalBytes>PROVIDER_MAX_AUDIO_BYTES) throw new NarrationApiError('NARRATION_INPUT_UNSUPPORTED','Combined audio exceeds the narration limit');
        const wav=parseWavPcm(audio.bytes);
        parts.push({bytes:audio.bytes,wav});
        if(model&&alignment.status==='available') {
          try {
            const sentences=chunk.spans.map((span,i)=>({sentenceId:String(i),range:{start:map[span.start]-map[chunk.start],end:map[span.end]-map[chunk.start]}}));
            const result=await alignChunk({wavBytes:audio.bytes,speechSlice:slice,sentences,sliceStart:0,model});
            if(result.timings.length!==sentences.length) throw new Error('Missing sentence timing');
            for(const timing of result.timings) {
              const span=chunk.spans[Number(timing.sentenceId)];
              cues.push({page:input.page,start:input.start+paragraph.start+span.start,end:input.start+paragraph.start+span.end,text:canonical.slice(span.start,span.end),startMs:Math.round(durationMs+timing.startMs),endMs:Math.round(durationMs+timing.endMs)});
            }
            alignment={status:'available',modelIdentity:result.modelIdentity,alignerVersion:result.alignerVersion};
          } catch {alignment={status:'failed',reason:'NARRATION_ALIGNMENT_FAILED'};cues.length=0;}
        }
        durationMs+=wav.durationMs;
      }
    }
    if(!parts.length) throw new NarrationApiError('NARRATION_INPUT_UNSUPPORTED','No speakable Book text');
    const bytes=stitch(parts);
    return {audioBase64:Buffer.from(bytes).toString('base64'),mimeType:'audio/wav',durationMs:Math.round(durationMs),sha256:sha256HexBytes(bytes),cues,alignment,profile:{model:NARRATION_PROFILE.model,voice:NARRATION_PROFILE.voice}};
  } finally {if(model) await model.dispose();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    let raw='';for await(const chunk of process.stdin) {raw+=chunk;if(raw.length>300000) throw new NarrationApiError('NARRATION_INPUT_UNSUPPORTED','Request too large');}
    process.stdout.write(JSON.stringify({ok:true,result:await generate(JSON.parse(raw))}));
  } catch(error) {process.stdout.write(JSON.stringify({ok:false,error:{code:error.code ?? 'NARRATION_GENERATION_FAILED',retryAfterMs:error.options?.retryAfterMs}}));}
}
