import { pipeline, env } from '/transformers/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = '/transformers/';

let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny',
      {
        quantized: true,
        progress_callback: progress => {
          self.postMessage({ type: 'model-progress', progress });
        }
      }
    ).catch(error => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

self.onmessage = async event => {
  if (!event.data || event.data.type !== 'transcribe') return;
  let inferenceTimer = 0;
  try {
    self.postMessage({ type: 'status', status: 'Loading speech model…' });
    const transcriber = await getTranscriber();
    self.postMessage({ type: 'status', status: 'Analyzing captions…' });
    let inferenceProgress = 86;
    let inferenceSeconds = 0;
    inferenceTimer = self.setInterval(() => {
      inferenceSeconds += 2;
      inferenceProgress = Math.min(98, inferenceProgress + 1);
      self.postMessage({
        type: 'inference-progress',
        progress: inferenceProgress,
        seconds: inferenceSeconds
      });
    }, 2000);
    const audio = new Float32Array(event.data.audio);
    const result = await transcriber(audio, {
      task: 'transcribe',
      return_timestamps: 'word',
      chunk_length_s: 24,
      stride_length_s: 4,
      num_beams: 1,
      temperature: 0
    });
    self.clearInterval(inferenceTimer);
    self.postMessage({
      type: 'complete',
      text: String(result && result.text || ''),
      chunks: Array.isArray(result && result.chunks) ? result.chunks : []
    });
  } catch (error) {
    if (inferenceTimer) self.clearInterval(inferenceTimer);
    self.postMessage({
      type: 'error',
      error: error && error.message ? error.message : 'Caption processing failed.'
    });
  }
};
