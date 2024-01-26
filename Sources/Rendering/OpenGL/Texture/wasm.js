/* eslint-disable no-nested-ternary */
import wasmPromise from 'vtk.js-wasm-util';

const wasm = await wasmPromise;

function transformHalfFloat(src, pixCount) {
  const [functionName, memory] =
    src instanceof Float32Array
      ? ['transformHalfFloat32', wasm.HEAPF32]
      : src instanceof Int16Array
      ? ['transformHalfFloat16', wasm.HEAP16]
      : src instanceof Uint16Array
      ? ['transformHalfFloatU16', wasm.HEAPU16]
      : src instanceof Int8Array
      ? ['transformHalfFloat8', wasm.HEAP8]
      : src instanceof Uint8Array
      ? ['transformHalfFloatU8', wasm.HEAPU8]
      : ['transformHalfFloat64', wasm.HEAPF64]; // src instanceof Float64Array

  const srcPointer = wasm._malloc(pixCount * src.BYTES_PER_ELEMENT);
  memory.set(src, srcPointer / src.BYTES_PER_ELEMENT);

  const destPointer = wasm._malloc(pixCount * Uint16Array.BYTES_PER_ELEMENT);

  wasm.ccall(
    functionName,
    null,
    // src_ptr, src_size, dest_prt
    ['number', 'number', 'number'],
    [srcPointer, pixCount, destPointer]
  );

  const newArray = new Uint16Array(
    wasm.HEAPU16.buffer.slice(
      destPointer,
      destPointer + pixCount * Uint16Array.BYTES_PER_ELEMENT
    )
  );

  wasm._free(srcPointer);
  wasm._free(destPointer);

  return newArray;
}

export default { transformHalfFloat };
