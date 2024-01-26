/* eslint-disable no-nested-ternary */
import wasmPromise from 'vtk.js-wasm-util';

const wasm = await wasmPromise;

function computeRange2(values, component = 0, numberOfComponents = 1) {
  // console.debug('computeRangeWasmVer', computeRangeWasmVer);
  const returnValue = new Float64Array(2);
  const returnValuePointer = wasm._malloc(
    returnValue.length * returnValue.BYTES_PER_ELEMENT
  );
  wasm.HEAPF64.set(
    returnValue,
    returnValuePointer / returnValue.BYTES_PER_ELEMENT
  );

  const [functionName, memory] =
    values instanceof Float32Array
      ? ['computeRange32', wasm.HEAPF32]
      : values instanceof Int16Array
      ? ['computeRange16', wasm.HEAP16]
      : values instanceof Uint16Array
      ? ['computeRangeU16', wasm.HEAPU16]
      : values instanceof Int8Array
      ? ['computeRange8', wasm.HEAP8]
      : values instanceof Uint8Array
      ? ['computeRangeU8', wasm.HEAPU8]
      : ['computeRange64', wasm.HEAPF64]; // values instanceof Float64Array
  const valuesPointer = wasm._malloc(values.length * values.BYTES_PER_ELEMENT);
  // Slow
  memory.set(values, valuesPointer / values.BYTES_PER_ELEMENT);

  wasm.ccall(
    functionName,
    null,
    // retval_ptr, input_ptr, component, numberOfComponents, size
    ['number', 'number', 'number', 'number', 'number'],
    [
      returnValuePointer,
      valuesPointer,
      component,
      numberOfComponents,
      values.length,
    ]
  );

  const result = wasm.HEAPF64.subarray(
    returnValuePointer / returnValue.BYTES_PER_ELEMENT,
    returnValuePointer / returnValue.BYTES_PER_ELEMENT + returnValue.length
  );
  const [min, max] = result;

  wasm._free(returnValuePointer);
  wasm._free(valuesPointer);

  return {
    min,
    max,
  };
}

export default { computeRange2 };
