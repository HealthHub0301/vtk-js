import registerWebworker from 'webworker-promise/lib/register';

/* eslint-disable */
// prettier-ignore
registerWebworker(function (message, emit) {
  var array = message.array;
  var min = message.min;
  var max = message.max;

  /* Add rescale option in computing histogram for Gaussian Widget */
  var rescaleSlope = message.rescaleSlope || 1;
  var rescaleIntercept = message.rescaleIntercept || 0;

  var offset = message.component || 0;
  var step = message.numberOfComponents || 1;

  var numberOfBins = message.numberOfBins;
  var delta = max - min;
  var histogram = new Float32Array(numberOfBins);
  histogram.fill(0);
  var len = array.length;
  for (var i = offset; i < len; i += step) {
    var rescaledValue = Number(array[i]) * rescaleSlope + rescaleIntercept;
    var idx = Math.floor(
      (numberOfBins - 1) * (rescaledValue - min) / delta
    );
    histogram[idx] += 1;
  }

  for (var j=0; j<numberOfBins; j++) {
    histogram[j] = Math.sqrt(histogram[j]);
  }
  
  return Promise.resolve(
    new registerWebworker.TransferableResponse(histogram, [histogram.buffer])
  );
});