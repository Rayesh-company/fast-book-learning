/** Resolve the optional native runtime from its own dependency directory. */
export async function loadOnnxRuntime() {
  return await import('onnxruntime-node');
}
